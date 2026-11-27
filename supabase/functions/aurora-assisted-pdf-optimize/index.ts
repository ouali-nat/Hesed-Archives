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
const TOKEN = Deno.env.get("AURORA_LUALATEX_RENDER_TOKEN") || "";
let ADMIN_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!ADMIN_KEY) {
  try {
    ADMIN_KEY = String(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || "");
  } catch {
    ADMIN_KEY = "";
  }
}
if (!SUPA_URL || !ADMIN_KEY) throw new Error("Supabase server credentials are not configured.");

const admin = createClient(SUPA_URL, ADMIN_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const COURSE_ID = "bc62da2b-5ed8-4e7b-80e9-982a5d79425c";
const COURSE_TITLE = "Probabilités demo";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-aurore-render-token, x-aurore-course-id, x-aurore-course-title, x-aurore-block-id, x-aurore-page-path, x-aurore-page-count, x-aurore-quality-profile, x-aurore-source-backup-path, x-aurore-restore-source",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function validPath(path: string): boolean {
  return !path.startsWith("/") &&
    !path.includes("..") &&
    (path.startsWith("aurora-content-pages/") ||
     path.startsWith("aurora-assisted-sheet-pages/") ||
     path.startsWith("aurora-assisted-system-pages/"));
}

function validBackupPath(path: string): boolean {
  return !path.startsWith("/") &&
    !path.includes("..") &&
    path.startsWith("aurora-assisted-compression-backups/" + COURSE_ID + "/");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function systemPagePath(page: any): string {
  const raw = String(page?.pdfUrl || "");
  try {
    const parsed = new URL(raw);
    if (parsed.hostname !== new URL(SUPA_URL).hostname) return "";
    const prefix = "/storage/v1/object/sign/Pdfs/";
    if (!parsed.pathname.startsWith(prefix)) return "";
    return decodeURIComponent(parsed.pathname.slice(prefix.length));
  } catch {
    return "";
  }
}

async function loadTarget() {
  const { data, error } = await admin
    .from("aurora_assisted_courses")
    .select("id,title,pages,updated_at")
    .eq("id", COURSE_ID)
    .maybeSingle();
  if (error) throw new Error("Lecture du cours impossible: " + error.message);
  if (!data || data.title !== COURSE_TITLE) throw new Error("Cours cible introuvable ou titre différent.");
  return data as { id: string; title: string; pages: Record<string, unknown>; updated_at: string };
}

function locateTarget(pages: any, blockId: string, path: string): any | null {
  const course = pages?.course;
  if (blockId.startsWith("system:")) {
    const kind = blockId.slice("system:".length);
    if (!["cover", "toc", "end"].includes(kind)) return null;
    const page = course?.generation?.system_preview?.pages?.[kind];
    if (!page || page.status !== "ready" || systemPagePath(page) !== path) return null;
    return { kind: "system", value: page };
  }
  const blocks = course?.blocks;
  if (!Array.isArray(blocks)) return null;
  const block = blocks.find((candidate: any) =>
    String(candidate?.id || "") === blockId &&
    String(candidate?.generation?.page_path || "") === path &&
    String(candidate?.generation?.status || "") === "ready"
  );
  return block ? { kind: "block", value: block } : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Méthode non autorisée." }, 405);
  if (!TOKEN || req.headers.get("x-aurore-render-token") !== TOKEN) {
    return json({ ok: false, error: "Authentification invalide." }, 401);
  }

  const action = new URL(req.url).searchParams.get("action");
  if (action === "plan") {
    let body: any;
    try { body = await req.json(); } catch { return json({ ok: false, error: "JSON invalide." }, 400); }
    if (String(body?.course_id || "") !== COURSE_ID || String(body?.expected_title || "") !== COURSE_TITLE) {
      return json({ ok: false, error: "Ce point de terminaison est limité au cours Probabilités demo." }, 403);
    }
    try {
      const course = await loadTarget();
      const blocks = (course.pages as any)?.course?.blocks;
      if (!Array.isArray(blocks)) return json({ ok: false, error: "Liste des blocs du cours absente." }, 409);
      const pages: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const block of blocks) {
        const path = String(block?.generation?.page_path || "");
        const blockId = String(block?.id || "");
        if (!blockId || !validPath(path) || block?.generation?.status !== "ready" || seen.has(path)) continue;
        seen.add(path);
        const { data: signed, error } = await r2Storage.from("Pdfs").createSignedUrl(path, 60 * 60);
        if (error || !signed?.signedUrl) {
          return json({ ok: false, error: "Impossible de signer un fragment PDF du cours." }, 500);
        }
        const optimization = block?.generation?.pdf_optimization || {};
        const backupPath = String(optimization.source_backup_path || optimization.backup_path || "");
        let backupUrl = "";
        if (validBackupPath(backupPath)) {
          const backupSigned = await r2Storage.from("Pdfs").createSignedUrl(backupPath, 60 * 60);
          if (!backupSigned.error && backupSigned.data?.signedUrl) backupUrl = backupSigned.data.signedUrl;
        }
        pages.push({
          block_id: blockId,
          title: String(block?.content?.title || block?.type || blockId),
          path,
          bytes: Number(block?.generation?.bytes || 0),
          page_number: Number(block?.generation?.page_number || 0),
          compression_status: String(optimization.status || ""),
          quality: String(optimization.quality || ""),
          backup_path: backupUrl ? backupPath : "",
          backup_url: backupUrl,
          url: signed.signedUrl,
        });
      }
      const systemPages = (course.pages as any)?.course?.generation?.system_preview?.pages;
      for (const kind of ["cover", "toc", "end"]) {
        const page = systemPages?.[kind];
        const path = systemPagePath(page);
        const blockId = "system:" + kind;
        if (!page || page.status !== "ready" || !validPath(path) || seen.has(path)) continue;
        seen.add(path);
        const { data: signed, error } = await r2Storage.from("Pdfs").createSignedUrl(path, 60 * 60);
        if (error || !signed?.signedUrl) {
          return json({ ok: false, error: "Impossible de signer une page système du cours." }, 500);
        }
        const optimization = page?.pdfOptimization || {};
        const backupPath = String(optimization.source_backup_path || optimization.backup_path || "");
        let backupUrl = "";
        if (validBackupPath(backupPath)) {
          const backupSigned = await r2Storage.from("Pdfs").createSignedUrl(backupPath, 60 * 60);
          if (!backupSigned.error && backupSigned.data?.signedUrl) backupUrl = backupSigned.data.signedUrl;
        }
        pages.push({
          block_id: blockId,
          title: String(page?.fingerprint || kind).includes("cover") ? "Couverture" : kind === "toc" ? "Sommaire" : "Page finale",
          path,
          bytes: Number(optimization.optimized_bytes || optimization.original_bytes || 0),
          page_number: Number(optimization.page_count || 0),
          compression_status: String(optimization.status || ""),
          quality: String(optimization.quality || ""),
          backup_path: backupUrl ? backupPath : "",
          backup_url: backupUrl,
          url: signed.signedUrl,
        });
      }
      return json({
        ok: true,
        course_id: course.id,
        title: course.title,
        fragment_count: pages.length,
        pages,
      });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (action !== "upload") return json({ ok: false, error: "Action inconnue." }, 400);
  const courseId = req.headers.get("x-aurore-course-id") || "";
  const courseTitle = req.headers.get("x-aurore-course-title") || "";
  const blockId = req.headers.get("x-aurore-block-id") || "";
  const path = req.headers.get("x-aurore-page-path") || "";
  const pageCount = Number(req.headers.get("x-aurore-page-count") || "0");
  const qualityProfile = req.headers.get("x-aurore-quality-profile") || "ebook";
  const sourceBackupPath = req.headers.get("x-aurore-source-backup-path") || "";
  const restoreSource = req.headers.get("x-aurore-restore-source") === "true";
  if (courseId !== COURSE_ID || !blockId || !validPath(path)) {
    return json({ ok: false, error: "Cible ou chemin de PDF non autorisé." }, 403);
  }
  if (!["ebook", "visual_fidelity"].includes(qualityProfile)) {
    return json({ ok: false, error: "Profil de compression non autorisé." }, 400);
  }
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 20) return json({ ok: false, error: "Nombre de pages du fragment invalide (1 à 20)." }, 400);
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    return json({ ok: false, error: "Le corps doit être un PDF application/pdf." }, 415);
  }

  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(await req.arrayBuffer());
  } catch {
    return json({ ok: false, error: "Lecture du PDF optimisé impossible." }, 400);
  }
  if (compressed.length < 1000 || compressed.length > 12 * 1024 * 1024 ||
      new TextDecoder().decode(compressed.slice(0, 5)) !== "%PDF-") {
    return json({ ok: false, error: "PDF optimisé invalide ou hors limite." }, 400);
  }

  try {
    let course = await loadTarget();
    const located = locateTarget(course.pages, blockId, path);
    if (!located) {
      return json({ ok: false, error: "Le bloc ou le chemin ne correspond plus au cours." }, 409);
    }
    const currentOptimization = located.kind === "block"
      ? (located.value?.generation?.pdf_optimization || {})
      : (located.value?.pdfOptimization || {});
    const approvedSourceBackup = String(currentOptimization.source_backup_path || currentOptimization.backup_path || "");
    if (sourceBackupPath) {
      if (!validBackupPath(sourceBackupPath) || sourceBackupPath !== approvedSourceBackup) {
        return json({ ok: false, error: "La sauvegarde source ne correspond pas au fragment ciblé." }, 403);
      }
    } else if (restoreSource) {
      return json({ ok: false, error: "La restauration exige une sauvegarde source vérifiée." }, 400);
    }

    const { data: sourceBlob, error: downloadError } = await r2Storage.from("Pdfs").download(path);
    if (downloadError || !sourceBlob) {
      return json({ ok: false, error: "PDF source introuvable dans Storage." }, 404);
    }
    const currentLive = new Uint8Array(await sourceBlob.arrayBuffer());
    if (new TextDecoder().decode(currentLive.slice(0, 5)) !== "%PDF-") {
      return json({ ok: false, error: "PDF source invalide; aucune modification effectuée." }, 409);
    }

    let comparisonSource = currentLive;
    if (sourceBackupPath) {
      const { data: backupBlob, error: sourceBackupError } = await r2Storage.from("Pdfs").download(sourceBackupPath);
      if (sourceBackupError || !backupBlob) {
        return json({ ok: false, error: "Sauvegarde haute qualité introuvable; fichier courant conservé." }, 404);
      }
      comparisonSource = new Uint8Array(await backupBlob.arrayBuffer());
      if (new TextDecoder().decode(comparisonSource.slice(0, 5)) !== "%PDF-") {
        return json({ ok: false, error: "La sauvegarde source n'est pas un PDF valide; fichier courant conservé." }, 409);
      }
    }

    if (restoreSource) {
      if (!sameBytes(compressed, comparisonSource)) {
        return json({ ok: false, error: "Le mode restauration accepte uniquement les octets exacts de la sauvegarde vérifiée." }, 409);
      }
    } else if (compressed.length >= comparisonSource.length - 128) {
      return json({ ok: false, error: "Aucun gain de taille utile sur la source haute qualité; fichier courant conservé.", original_bytes: comparisonSource.length, optimized_bytes: compressed.length }, 409);
    }

    const filename = path.split("/").pop() || "page.pdf";
    const previousVersionBackupPath = "aurora-assisted-compression-backups/" + COURSE_ID + "/" + crypto.randomUUID() + "/" + filename;
    const { error: backupError } = await r2Storage.from("Pdfs").upload(previousVersionBackupPath, currentLive, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: false,
    });
    if (backupError) return json({ ok: false, error: "Sauvegarde de la version courante impossible; aucun remplacement effectué." }, 500);

    const { error: uploadError } = await r2Storage.from("Pdfs").upload(path, compressed, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: true,
    });
    if (uploadError) return json({ ok: false, error: "Remplacement Storage impossible; les sauvegardes sont conservées." }, 500);

    const timestamp = new Date().toISOString();
    let metadataUpdated = false;
    const stableSourceBackup = sourceBackupPath || String(currentOptimization.source_backup_path || currentOptimization.backup_path || previousVersionBackupPath);
    for (let attempt = 0; attempt < 5; attempt++) {
      course = await loadTarget();
      const pages: any = structuredClone(course.pages);
      const target = locateTarget(pages, blockId, path);
      if (!target) break;
      const signed = await r2Storage.from("Pdfs").createSignedUrl(path, 60 * 60 * 24 * 30);
      const optimization = {
        status: restoreSource ? "source_restored" : "server_compressed",
        compressed: !restoreSource,
        quality: restoreSource ? "visual_fidelity_restored" : qualityProfile,
        original_bytes: comparisonSource.length,
        optimized_bytes: compressed.length,
        previous_live_bytes: currentLive.length,
        saved_bytes: Math.max(0, comparisonSource.length - compressed.length),
        saved_percent: Number((Math.max(0, 1 - compressed.length / comparisonSource.length) * 100).toFixed(1)),
        page_count: pageCount,
        backup_path: stableSourceBackup,
        source_backup_path: stableSourceBackup,
        previous_version_backup_path: previousVersionBackupPath,
        updated_at: timestamp,
      };
      if (target.kind === "block") {
        const block = target.value;
        block.generation = block.generation || {};
        block.generation.bytes = compressed.length;
        block.generation.updated_at = timestamp;
        if (signed.data?.signedUrl) block.generation.page_url = signed.data.signedUrl;
        block.generation.pdf_optimization = optimization;
      } else {
        const page = target.value;
        if (signed.data?.signedUrl) page.pdfUrl = signed.data.signedUrl;
        page.pdfOptimization = { ...(page.pdfOptimization || {}), ...optimization, error: null };
      }
      const { data: saved, error: updateError } = await admin
        .from("aurora_assisted_courses")
        .update({ pages, updated_at: timestamp })
        .eq("id", COURSE_ID)
        .eq("updated_at", course.updated_at)
        .select("id")
        .maybeSingle();
      if (!updateError && saved?.id) {
        metadataUpdated = true;
        break;
      }
    }

    return json({
      ok: true,
      course_id: COURSE_ID,
      block_id: blockId,
      path,
      quality: restoreSource ? "visual_fidelity_restored" : qualityProfile,
      source_bytes: comparisonSource.length,
      previous_live_bytes: currentLive.length,
      optimized_bytes: compressed.length,
      saved_bytes: Math.max(0, comparisonSource.length - compressed.length),
      backup_path: stableSourceBackup,
      previous_version_backup_path: previousVersionBackupPath,
      restored_source: restoreSource,
      metadata_updated: metadataUpdated,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
