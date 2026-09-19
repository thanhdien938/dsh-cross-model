import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);
