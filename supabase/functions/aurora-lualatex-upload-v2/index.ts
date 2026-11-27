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
const SUPA_URL=Deno.env.get("SUPABASE_URL")!,SECRET_KEYS=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"),ADMIN_KEY=SECRET_KEYS.default,TOKEN=Deno.env.get("AURORA_LUALATEX_RENDER_TOKEN")!;
const R2_WORKER_URL="https://lsnb-pdf-worker-v2.oualikevin9.workers.dev",R2_PUBLIC_URL="https://pub-0433751d08eb49fcafb7355ef0bf42ab.r2.dev";
const adminClient=createClient(SUPA_URL,ADMIN_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type, x-aurore-render-token, x-aurore-document-id, x-aurore-commit","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
function safeSlug(v:string){return String(v||"document").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\w\s-]/g,"").trim().replace(/\s+/g,"-").slice(0,90)||"document"}
function safeSegment(v:string,fallback:string){const s=String(v||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\w\s-]/g,"").trim().replace(/\s+/g,"-").replace(/-+/g,"-").slice(0,70);return s||fallback}
function publicR2Url(path:string){return R2_PUBLIC_URL+"/"+path.split("/").map(encodeURIComponent).join("/")}
function workerR2Url(path:string){return R2_WORKER_URL+"/"+path.split("/").map(encodeURIComponent).join("/")}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Méthode non autorisée"},405);
 if(!TOKEN||req.headers.get("x-aurore-render-token")!==TOKEN)return json({error:"Authentification invalide"},401);
 const id=Number(req.headers.get("x-aurore-document-id"));if(!Number.isSafeInteger(id)||id<1)return json({error:"x-aurore-document-id invalide"},400);
 const ct=req.headers.get("content-type")||"";if(!ct.toLowerCase().startsWith("application/pdf"))return json({error:"Le corps doit être un PDF application/pdf"},415);
 const {data:doc,error:de}=await adminClient.from("aurora_generated_documents").select("id,job_id,created_by,title,created_at,version,status,pdf_path,pdf_url,metadata,subject,matiere,level,class_name,document_type,domaine,formation,specialite,annee,semestre,filiere,theme_color").eq("id",id).maybeSingle();
 if(de)return json({error:de.message},500);if(!doc)return json({error:"Document introuvable"},404);
 const initialMetadata=doc.metadata&&typeof doc.metadata==="object"?doc.metadata:{};if(initialMetadata.lualatex_cancel_requested===true)return json({ok:false,cancelled:true,error:"Génération annulée par l’administration."},409);
 const {data:job,error:je}=await adminClient.from("aurora_content_jobs").select("id,created_by,instructions,metadata").eq("id",doc.job_id).maybeSingle();if(je)return json({error:je.message},500);
 const effectiveCreatedBy=doc.created_by||job?.created_by||null;
 if(!doc.created_by && effectiveCreatedBy){
   const {error:creatorSyncError}=await adminClient.from("aurora_generated_documents").update({created_by:effectiveCreatedBy,updated_at:new Date().toISOString()}).eq("id",id);
   if(creatorSyncError)return json({error:"Impossible de synchroniser le créateur du document: "+creatorSyncError.message},500);
 }
 const jobInstructions=job?.instructions&&typeof job.instructions==="object"?job.instructions:{},jobMetadata=job?.metadata&&typeof job.metadata==="object"?job.metadata:{};
 const bytes=new Uint8Array(await req.arrayBuffer());if(bytes.length<5||new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-")return json({error:"PDF invalide: signature %PDF- absente"},400);if(bytes.length>25*1024*1024)return json({error:"PDF trop volumineux"},413);
 const version=Number(doc.version)||1,year=doc.created_at?new Date(doc.created_at).getUTCFullYear():new Date().getUTCFullYear(),documentKey=`AUR-${year}-${String(id).padStart(6,"0")}`,qrTarget=`https://aurore-section-archivescom.vercel.app/?document=${id}`,hasGeoGebra=Boolean((doc.metadata&&typeof doc.metadata==="object"&&(doc.metadata as any).geogebra));
 const digest=await crypto.subtle.digest("SHA-256",bytes),pdfSha256=Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2,"0")).join(""),commit=req.headers.get("x-aurore-commit")==="true";
 if(!commit){const testPath=`aurora-lualatex-test/${effectiveCreatedBy||"system"}/${doc.id}/v${version}-${safeSlug(doc.title)}.pdf`;const {error:ue}=await r2Storage.from("Pdfs").upload(testPath,bytes,{contentType:"application/pdf",cacheControl:"3600",upsert:true});if(ue)return json({error:`Storage test: ${ue.message}`},500);const signedTest=await r2Storage.from("Pdfs").createSignedUrl(testPath,60*60*24*30);if(signedTest.error||!signedTest.data?.signedUrl)return json({error:signedTest.error?.message||"URL signée indisponible"},500);const publicUrl=signedTest.data.signedUrl;return json({ok:true,mode:"test",generated_document_id:id,pdf_path:testPath,pdf_url:publicUrl,bytes:bytes.length,database_updated:false})}
 const currentCheck=await adminClient.from("aurora_generated_documents").select("metadata").eq("id",id).maybeSingle();if(currentCheck.error)return json({error:currentCheck.error.message},500);const latestMetadata=currentCheck.data?.metadata&&typeof currentCheck.data.metadata==="object"?currentCheck.data.metadata:{};if(latestMetadata.lualatex_cancel_requested===true)return json({ok:false,cancelled:true,error:"Génération annulée par l’administration."},409);const metadata=latestMetadata;
 const classification=(metadata as any).classification&&typeof (metadata as any).classification==="object"?metadata.classification:{},jobClassification=(jobInstructions as any).classification&&typeof (jobInstructions as any).classification==="object"?jobInstructions.classification:{};
 const category=safeSegment(String(jobClassification.category||jobClassification.categorie||jobInstructions.category||classification.category||classification.categorie||jobMetadata.category||doc.document_type||"Documents"),"Documents"),level=safeSegment(String(jobClassification.level||jobClassification.niveau||classification.level||classification.niveau||doc.level||"Culture-generale"),"Culture-generale"),filiere=safeSegment(String(jobClassification.filiere||jobInstructions.filiere||classification.filiere||jobMetadata.filiere||doc.filiere||"Commun"),"Commun"),classe=safeSegment(String(jobClassification.class_name||jobClassification.classe||classification.class_name||classification.classe||doc.class_name||"Toutes-classes"),"Toutes-classes"),subject=safeSegment(String(jobClassification.subject||jobClassification.matiere||classification.subject||classification.matiere||doc.subject||doc.matiere||"Autres-matieres"),"Autres-matieres");
 const attemptId=Number((metadata as any).production_attempt_id||0); const attemptSuffix=Number.isSafeInteger(attemptId)&&attemptId>0?`-attempt-${attemptId}`:""; const r2Path=["aurore",level,filiere,classe,subject,category,`AUR-${year}-${String(id).padStart(6,"0")}-v${version}${attemptSuffix}-${safeSlug(doc.title)}.pdf`].join("/");
 const uploadResponse=await fetch(workerR2Url(r2Path),{method:"PUT",headers:{"Authorization":"Bearer "+ADMIN_KEY,"apikey":Deno.env.get("SUPABASE_ANON_KEY")||"","Content-Type":"application/pdf"},body:bytes});if(!uploadResponse.ok){const detail=(await uploadResponse.text().catch(()=>"")).slice(0,1000);return json({error:`R2 Worker: HTTP ${uploadResponse.status}${detail?` — ${detail}`:""}`},502);}
 const finalCheck=await adminClient.from("aurora_generated_documents").select("metadata").eq("id",id).maybeSingle();if(finalCheck.error)return json({error:finalCheck.error.message},500);const finalMetadata=finalCheck.data?.metadata&&typeof finalCheck.data?.metadata==="object"?finalCheck.data.metadata:{};if(finalMetadata.lualatex_cancel_requested===true)return json({ok:false,cancelled:true,error:"Génération annulée par l’administration. Le fichier R2 peut nécessiter un nettoyage ultérieur."},409);const now=new Date().toISOString();const nextMetadata={...finalMetadata,origin:"aurore",storage_provider:"cloudflare-r2",storage_bucket:"lsnb-documents",r2_path:r2Path,lualatex_status:"completed",lualatex_engine:"github-actions-lualatex-v1",lualatex_completed_at:now,pipeline:"DeepSeek -> Luna -> LuaLaTeX",renderer:"github-actions-lualatex-v1",aurore_document_key:`AUR-${year}-${String(id).padStart(6,"0")}`,qr_target:qrTarget,rights_notice_version:1,creator_source:effectiveCreatedBy?"supabase_auth_or_job":"machine_ingest",has_geogebra_attribution:hasGeoGebra,pdf_sha256:pdfSha256,classification:{level:level||null,filiere:filiere||null,class_name:classe||null,subject:subject||null,category:category||"Documents",resource_type:jobClassification.resource_type||(finalMetadata as any).classification?.resource_type||doc.document_type||null}};
 const {error:dbError}=await adminClient.from("aurora_generated_documents").update({pdf_path:r2Path,pdf_url:publicR2Url(r2Path),updated_at:now,metadata:nextMetadata,pdf_diagnostic:{engine:"github-actions-lualatex-v1",generated_at:now,bytes:bytes.length,source:"github-actions",storage_provider:"cloudflare-r2",storage_bucket:"lsnb-documents",r2_path:r2Path,sha256:pdfSha256,document_key:`AUR-${year}-${String(id).padStart(6,"0")}`,qr_target:qrTarget,rights_notice_version:1,has_geogebra_attribution:hasGeoGebra,creator_source:effectiveCreatedBy?"supabase_auth_or_job":"machine_ingest"}}).eq("id",id);if(dbError)return json({error:dbError.message},500);
 return json({ok:true,mode:"commit",generated_document_id:id,pdf_path:r2Path,pdf_url:publicR2Url(r2Path),bytes:bytes.length,database_updated:true,storage_provider:"cloudflare-r2"});
});