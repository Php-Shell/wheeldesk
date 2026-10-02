import {applyEvent,uid,validateImport} from './core.js';
const key='wheel-desk-v2';
export const seed={version:1,account:{name:'Alex Davis',value:10000,cash:10000},wheels:[{id:'demo-1',symbol:'AAPL',shares:100,strike:90,expiry:'2026-10-16',entryPrice:87.4,premium:.92,status:'open',mode:'paper',source:'fictional demo',createdAt:'2026-09-18'}],events:[],journal:[],settings:{theme:'dark',provider:'manual'},watchlist:[],trades:[],dividends:[],snapshots:[]};
export function load(){try{const x=JSON.parse(localStorage.getItem(key));return x?.version===1?x:structuredClone(seed)}catch{return structuredClone(seed)}}
export function save(s){localStorage.setItem(key,JSON.stringify(s));return s}
export function addWheel(s,w){return save(applyEvent(s,{id:uid(),type:'ADD_WHEEL',at:new Date().toISOString(),wheel:{...w,id:uid(),mode:'paper'}}))}
export function importState(text){const p=validateImport(JSON.parse(text));save(p);return p}
export function reset(){return save(structuredClone(seed))}
