import type { DB } from '../db/client';
import type { EmploymentHealthDTO } from '../../shared/types';
import { getExecutorManifest } from '../executors/manifests';

interface EmploymentRow { id:string;executor_profile_id:string|null;executor_name:string|null;permission_policy_id:string|null;manifest_id:string|null;policy_name:string|null;approval_strategy:string|null;scope:string|null }
interface ProbeRow { status:string;classification:string|null;completed_at:string|null;version:string|null;model:string|null }

const diagnosis:Record<string,string>={not_found:'没有找到本机 CLI',version_failed:'无法读取 CLI 版本',version_too_old:'CLI 版本过旧',authentication_failed:'CLI 尚未完成认证',model_failed:'指定模型不可用',network_failed:'网络连接失败',timeout:'联通测试超时',permission_bridge_failed:'审批桥不可用',invalid_output:'CLI 返回了无法识别的结果',mutated_workspace:'联通测试意外修改了文件'};
const probeDto=(probe:ProbeRow|null)=>probe?{status:probe.status,classification:probe.classification,completedAt:probe.completed_at,version:probe.version}:null;

export function getEmploymentHealth(db:DB,employeeId:string):EmploymentHealthDTO{
  const employment=db.prepare(`SELECT ce.id,ce.executor_profile_id,ep.name executor_name,ce.permission_policy_id,ep.manifest_id,
    pp.name policy_name,pp.approval_strategy,pp.scope FROM employee ce
    LEFT JOIN executor_profile ep ON ep.id=ce.executor_profile_id LEFT JOIN permission_policy pp ON pp.id=ce.permission_policy_id WHERE ce.id=?`).get(employeeId) as EmploymentRow|undefined;
  if(!employment)throw new Error(`company employee not found: ${employeeId}`);
  const baseProbe=employment.executor_profile_id?(db.prepare("SELECT status,classification,completed_at,version,model FROM connection_probe WHERE executor_profile_id=? AND kind='connectivity' ORDER BY created_at DESC,id DESC LIMIT 1").get(employment.executor_profile_id) as ProbeRow|undefined)??null:null;
  const modelProbe=employment.executor_profile_id?(db.prepare("SELECT status,classification,completed_at,version,model FROM connection_probe WHERE executor_profile_id=? AND kind='model' ORDER BY created_at DESC,id DESC LIMIT 1").get(employment.executor_profile_id) as ProbeRow|undefined)??null:null;
  const permission=employment.permission_policy_id?{policyId:employment.permission_policy_id,name:employment.policy_name!,strategy:employment.approval_strategy!,scope:employment.scope!}:null;
  const metadata={executorProfileId:employment.executor_profile_id,executorName:employment.executor_name,manifestId:employment.manifest_id,probe:baseProbe?{status:baseProbe.status,classification:baseProbe.classification,completedAt:baseProbe.completed_at}:null,probeDetails:probeDto(baseProbe),modelProbe:modelProbe?{...probeDto(modelProbe)!,model:modelProbe.model}:null,permission};
  const result=(value:Pick<EmploymentHealthDTO,'state'|'code'|'label'|'detail'|'action'>):EmploymentHealthDTO=>({...value,...metadata,reasons:[value.detail],remediation:value.action});
  if(!employment.executor_profile_id)return result({state:'blocked',code:'executor-missing',label:'尚不能工作',detail:'还没有为这项公司任职绑定固定执行器。',action:{label:'绑定执行器',href:'/executors'}});
  if(!permission)return result({state:'blocked',code:'permission-missing',label:'权限未设置',detail:'执行器已绑定，但尚未确定可操作范围。',action:{label:'绑定权限',href:'/permissions'}});
  if(!baseProbe)return result({state:'blocked',code:'probe-missing',label:'尚未联通',detail:'配置已保存，但还没有成功验证此执行器。',action:{label:'运行联通测试',href:`/executors?profile=${employment.executor_profile_id}`}});
  if(baseProbe.status==='queued'||baseProbe.status==='testing')return result({state:'checking',code:'probe-running',label:'正在检查',detail:'Muster 正在验证本地执行器，完成后会自动更新。',action:{label:'查看测试',href:`/executors?profile=${employment.executor_profile_id}`}});
  if(baseProbe.status!=='connected'){const reason=diagnosis[baseProbe.classification??'']??'执行器联通失败';return result({state:'blocked',code:'probe-failed',label:'执行器不可用',detail:`${reason}。员工配置会保留，修复后可重新测试。`,action:{label:'查看原因并复检',href:`/executors?profile=${employment.executor_profile_id}`}});}
  const manifest=getExecutorManifest(employment.manifest_id!);
  if(manifest.approvalBridge==='none')return result({state:'checking',code:'approval-bridge-limited',label:'仅限受限运行',detail:'联通正常，但该执行器无法接管审批，只能以关闭 stdin 和有限超时方式运行。',action:{label:'了解限制',href:`/executors?profile=${employment.executor_profile_id}`}});
  return result({state:'ready',code:'ready',label:'可以工作',detail:modelProbe?.status==='failed'?'基础联通正常；员工指定模型测试失败，未影响默认模型可用性。':'执行器联通、权限范围和审批桥均已准备。',action:null});
}
