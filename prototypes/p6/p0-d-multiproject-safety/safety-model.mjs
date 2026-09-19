import {routeTelegramUpdate} from '../../../src/owner/telegram-owner-client.mjs';

export class ProjectArmModel{
  constructor(projects){this.projects=new Set(projects);this.selected=null;this.armed=null;this.draft=null;}
  select(id){this.#known(id);this.selected=id;if(this.draft&&this.draft.project_id!==id)this.draft={...this.draft,send_enabled:false};return this.snapshot();}
  arm(id){this.#known(id);this.armed=id;if(this.selected===id&&this.draft)this.draft={...this.draft,project_id:id,send_enabled:true};return this.snapshot();}
  type(body){if(!this.selected)throw new Error('project not selected');this.draft={body,project_id:this.selected,send_enabled:this.armed===this.selected};return this.snapshot();}
  submit(){if(!this.draft?.send_enabled||this.selected!==this.armed||this.draft.project_id!==this.armed)return{status:'REFUSED',code:'PROJECT_NOT_ARMED'};return{status:'READY',project_id:this.armed,body:this.draft.body};}
  snapshot(){return{selected:this.selected,armed:this.armed,draft:this.draft&&{...this.draft}};}
  #known(id){if(!this.projects.has(id))throw new Error('unknown project');}
}

export function routeMultiProjectTelegram(update,{projects,ownerUserId,ownerChatId,boundInteraction}={}){
  const text=String(update?.message?.text??'').trim();
  if(text==='/projects')return{read:'GET_PROJECTS',client_kind:'TELEGRAM'};
  if(projects.length===1)return routeTelegramUpdate(update,{ownerUserId,ownerChatId,projectId:projects[0].id,boundInteraction});
  const match=text.match(/^@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s+([\s\S]+)$/);
  if(!match)return{refused:true,code:'TELEGRAM_PROJECT_REQUIRED',projects:projects.map(p=>p.id)};
  const project=projects.find(p=>p.id===match[1]);if(!project)return{refused:true,code:'TELEGRAM_PROJECT_UNKNOWN',projects:projects.map(p=>p.id)};
  const copy=structuredClone(update);copy.message.text=match[2];const command=routeTelegramUpdate(copy,{ownerUserId,ownerChatId,projectId:project.id,boundInteraction});return{...command,acknowledgement:`Accepted for project ${project.id}`};
}
