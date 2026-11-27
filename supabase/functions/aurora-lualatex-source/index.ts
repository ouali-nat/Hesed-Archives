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
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-aurore-render-token",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const expectedToken = Deno.env.get("AURORA_LUALATEX_RENDER_TOKEN");
  if (!expectedToken) {
    return json({ error: "renderer_token_not_configured" }, 503);
  }

  const suppliedToken = req.headers.get("x-aurore-render-token");
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const documentId = url.searchParams.get("document_id");
  if (!documentId || !/^\d+$/.test(documentId)) {
    return json({ error: "invalid_document_id" }, 400);
  }

  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysRaw) {
    return json({ error: "supabase_secret_keys_unavailable" }, 503);
  }

  let secretKey: string;
  try {
    const secretKeys = JSON.parse(secretKeysRaw);
    secretKey = secretKeys.default;
  } catch {
    return json({ error: "invalid_supabase_secret_keys" }, 503);
  }

  if (!secretKey) {
    return json({ error: "default_supabase_secret_key_unavailable" }, 503);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, secretKey);

  const { data, error } = await supabase
    .from("aurora_generated_documents")
    .select("id,title,subject,level,class_name,document_type,source_format,content_json,version,status,metadata")
    .eq("id", Number(documentId))
    .maybeSingle();

  if (error) {
    return json({ error: "database_read_failed", details: error.message }, 500);
  }

  if (!data) {
    return json({ error: "document_not_found" }, 404);
  }

  const graphAssets: Array<{ section_index: number; graph_index: number; path: string; url: string }> = [];
  const sections = Array.isArray((data as any).content_json?.sections)
    ? (data as any).content_json.sections
    : [];
  for (let si = 0; si < sections.length; si++) {
    const graphs = Array.isArray(sections[si]?.graphs) ? sections[si].graphs : [];
    for (let gi = 0; gi < graphs.length; gi++) {
      const path = String(graphs[gi]?.geogebra_image_path || "");
      if (!path) continue;
      const signed = await r2Storage.from("Pdfs").createSignedUrl(path, 900);
      if (!signed.error && signed.data?.signedUrl) {
        graphAssets.push({ section_index: si, graph_index: gi, path, url: signed.data.signedUrl });
      }
    }
  }

  const contentJson = data.content_json && typeof data.content_json === "object"
    ? { ...data.content_json }
    : data.content_json;

  const design = data.metadata && typeof data.metadata === "object"
    && data.metadata.aurore_design && typeof data.metadata.aurore_design === "object"
    ? data.metadata.aurore_design
    : null;

  if (contentJson && typeof contentJson === "object" && design) {
    contentJson._aurore_design = {
      ...(contentJson._aurore_design && typeof contentJson._aurore_design === "object"
        ? contentJson._aurore_design
        : {}),
      ...design,
    };
  }

  const sourceDocument = {
    ...data,
    content_json: contentJson,
  };

  return json({
    document: sourceDocument,
    graph_assets: graphAssets,
    renderer: "aurore-lualatex-v1",
  });
});
