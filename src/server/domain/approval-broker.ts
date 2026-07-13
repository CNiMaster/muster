export type ApprovalResolution='allow'|'deny'|'timeout'|'shutdown';
class ApprovalBroker{
  private waiters=new Map<string,{resolve:(value:ApprovalResolution)=>void;timer:NodeJS.Timeout}>();
  wait(id:string,timeoutMs=600_000):Promise<ApprovalResolution>{return new Promise(resolve=>{const timer=setTimeout(()=>{this.waiters.delete(id);resolve('timeout');},timeoutMs);this.waiters.set(id,{resolve,timer});});}
  hasWaiter(id:string):boolean{return this.waiters.has(id);}
  resolve(id:string,value:ApprovalResolution):boolean{const waiter=this.waiters.get(id);if(!waiter)return false;clearTimeout(waiter.timer);this.waiters.delete(id);waiter.resolve(value);return true;}
  rejectAll():void{for(const[id]of this.waiters)this.resolve(id,'shutdown');}
}
export {ApprovalBroker};
export const approvalBroker=new ApprovalBroker();
