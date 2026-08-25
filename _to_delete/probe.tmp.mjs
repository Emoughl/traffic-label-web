import fs from "fs";
import { google } from "googleapis";
const env = Object.fromEntries(
  fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{
    const i=l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")];
  })
);
const auth = new google.auth.JWT({
  email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g,"\n"),
  scopes:["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({version:"v3", auth});
const root = env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
async function ls(id,label){
  const r = await drive.files.list({q:`'${id}' in parents and trashed=false`,fields:"files(id,name,mimeType,modifiedTime)",pageSize:20,supportsAllDrives:true,includeItemsFromAllDrives:true,orderBy:"modifiedTime desc"});
  console.log("--",label,id);
  for(const f of r.data.files) console.log("   ", f.mimeType.includes("folder")?"[DIR]":"     ", f.name, f.modifiedTime);
  return r.data.files;
}
const rootMeta = await drive.files.get({fileId:root, fields:"id,name,mimeType,shortcutDetails",supportsAllDrives:true});
console.log("ROOT:", rootMeta.data.name, rootMeta.data.mimeType);
const realRoot = rootMeta.data.shortcutDetails?.targetId || root;
const kids = await ls(realRoot,"root");
const deleted = kids.find(f=>f.name==="Deleted");
if(deleted){ const d = await ls(deleted.id,"Deleted");
  for(const sub of d.filter(f=>f.mimeType.includes("folder"))) await ls(sub.id,"Deleted/"+sub.name);
}
