import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";


const R2_STORAGE_WORKER_URL = "https://lsnb-pdf-worker-v2.oualikevin9.workers.dev";
const R2_STORAGE_PUBLIC_URL = "https://pub-0433751d08eb49fcafb7355ef0bf42ab.r2.dev";
const R2_STORAGE_SERVICE_TOKEN = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (() => { try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { return ""; } })();
function r2StorageKeyUrl(path: string) { return R2_STORAGE_WORKER_URL + "/" + String(path).split("/").map(encodeURIComponent).join("/"); }
function r2StoragePublicUrl(path: string) { return R2_STORAGE_PUBLIC_URL + "/" + String(path).split("/").map(encodeURIComponent).join("/"); }
const r2Storage = {
  from(_bucket: string) {
    return {
      async upload(path: string, body: BodyInit, options: any = {}) {
        try {
          if (!R2_STORAGE_SERVICE_TOKEN) return { data: null, error: { message: "Jeton serveur R2 indisponible." } };
          const response = await fetch(r2StorageKeyUrl(path), { method: "PUT", headers: { Authorization: "Bearer " + R2_STORAGE_SERVICE_TOKEN, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "", "Content-Type": options.contentType || "application/octet-stream" }, body });
          if (!response.ok) return { data: null, error: { message: "R2 upload HTTP " + response.status + ": " + (await response.text()).slice(0, 500) } };
          return { data: { path }, error: null };
        } catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }; }
      },
      async download(path: string) {
        try { const response = await fetch(r2StorageKeyUrl(path)); if (!response.ok) return { data: null, error: { message: "R2 download HTTP " + response.status } }; return { data: await response.blob(), error: null }; }
        catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }; }
      },
      async createSignedUrl(path: string, _expiresIn?: number) { return { data: { signedUrl: r2StoragePublicUrl(path) }, error: null }; },
      async createSignedUrls(paths: string[], _expiresIn?: number) { return { data: { signedUrls: paths.map(path => ({ path, signedUrl: r2StoragePublicUrl(path) })) }, error: null }; },
      async createSignedUploadUrl(path: string) { return { data: { signedUrl: r2StorageKeyUrl(path), token: null, path }, error: null }; },
      getPublicUrl(path: string) { return { data: { publicUrl: r2StoragePublicUrl(path) } }; }
    };
  }
};
const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const ADMIN_KEY = SECRET_KEYS.default;
const TOKEN = Deno.env.get("AURORA_LUALATEX_RENDER_TOKEN")!;

const admin = createClient(SUPA_URL, ADMIN_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-aurore-render-token, x-aurore-document-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function safeSlug(value: string) {
  return String(value || "document")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 90) || "document";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const token = req.headers.get("x-aurore-render-token");
  if (!TOKEN || !token || token !== TOKEN) return json({ error: "Authentification invalide" }, 401);

  const id = Number(req.headers.get("x-aurore-document-id"));
  if (!Number.isSafeInteger(id) || id < 1) {
    return json({ error: "x-aurore-document-id invalide" }, 400);
  }

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    return json({ error: "Le corps doit être un PDF application/pdf" }, 415);
  }

  const { data: doc, error: docError } = await admin
    .from("aurora_generated_documents")
    .select("id,created_by,title,version,status,pdf_path,pdf_url")
    .eq("id", id)
    .maybeSingle();

  if (docError) return json({ error: docError.message }, 500);
  if (!doc) return json({ error: "Document introuvable" }, 404);
  if (!doc.created_by) return json({ error: "Document sans created_by" }, 409);

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    return json({ error: "PDF invalide: signature %PDF- absente" }, 400);
  }
  if (bytes.length > 25 * 1024 * 1024) {
    return json({ error: "PDF trop volumineux" }, 413);
  }

  const version = Number(doc.version) || 1;
  const path = `aurora-lualatex-generated/${doc.created_by}/${doc.id}/v${version}-${safeSlug(doc.title)}.pdf`;

  const { error: uploadError } = await r2Storage
    .from("Pdfs")
    .upload(path, bytes, {
      contentType: "application/pdf",
      cacheControl: "31536000",
      upsert: true,
    });

  if (uploadError) return json({ error: `Storage: ${uploadError.message}` }, 500);

  const signed = await r2Storage.from("Pdfs").createSignedUrl(path, 60 * 60 * 24 * 30); if (signed.error || !signed.data?.signedUrl) return json({ error: signed.error?.message || "URL signée indisponible" }, 500); const publicUrl = signed.data.signedUrl;

  const { error: updateError } = await admin
    .from("aurora_generated_documents")
    .update({
      pdf_path: path,
      pdf_url: publicUrl,
      updated_at: new Date().toISOString(),
      pdf_diagnostic: {
        engine: "github-actions-lualatex-v1",
        generated_at: new Date().toISOString(),
        bytes: bytes.length,
        source: "github-actions",
      },
    })
    .eq("id", id);

  if (updateError) return json({ error: `Database: ${updateError.message}`, path }, 500);

  return json({
    ok: true,
    generated_document_id: id,
    pdf_path: path,
    pdf_url: publicUrl,
    bytes: bytes.length,
  });
});
