const mongoose=require("mongoose");
const InterviewPreparation=require("../models/InterviewPreparation");
const CareerProfile=require("../models/CareerProfile");
const CV=require("../models/CV");
const SkillGapAnalysis=require("../models/SkillGapAnalysis");
const JobMatch=require("../models/JobMatch");
const CareerPath=require("../models/CareerPath");
const {analyzeInterviewPreparation}=require("../services/aiService");
function isValid(id){return mongoose.Types.ObjectId.isValid(id);}
async function analyze(req,res){
 try{
  const userId=req.user._id;
  const profile=await CareerProfile.findOne({userId}).lean();
  if(!profile) return res.status(400).json({success:false,error:"Please create your Career Profile before generating interview preparation."});
  let targetRole=(req.body.targetRole||"").toString().trim();
  if(!targetRole) targetRole=(profile.targetRole||"").toString().trim();
  if(!targetRole) return res.status(400).json({success:false,error:"Please add a target role to your Career Profile or provide targetRole in the request."});
  let cvText=""; let cvAnalysis=null;
  if(req.body.cvId){
    const cvId=req.body.cvId.toString();
    if(!isValid(cvId)) return res.status(404).json({success:false,error:"CV not found."});
    const cv=await CV.findOne({_id:cvId,userId});
    if(!cv) return res.status(404).json({success:false,error:"CV not found."});
    cvText=cv.extractedText||""; cvAnalysis=cv.analysis||null;
  } else {
    const cv=await CV.findOne({userId}).sort({createdAt:-1});
    if(cv){cvText=cv.extractedText||""; cvAnalysis=cv.analysis||null;}
  }
  let skillGap=await SkillGapAnalysis.findOne({userId,targetRole}).sort({createdAt:-1}).lean();
  if(!skillGap) skillGap=await SkillGapAnalysis.findOne({userId}).sort({createdAt:-1}).lean();
  let careerPath=await CareerPath.findOne({userId,targetRole}).sort({createdAt:-1}).lean();
  if(!careerPath) careerPath=await CareerPath.findOne({userId}).sort({createdAt:-1}).lean();
  let job=null; let jobMatch=null;
  if(req.body.jobMatchId){
    const jmId=req.body.jobMatchId.toString();
    if(!isValid(jmId)) return res.status(404).json({success:false,error:"Job match not found."});
    jobMatch=await JobMatch.findOne({_id:jmId,userId});
    if(!jobMatch) return res.status(404).json({success:false,error:"Job match not found."});
    job={title:jobMatch.jobTitle,company:jobMatch.company,location:jobMatch.location,description:"",requirements:[]};
  } else if(req.body.job && typeof req.body.job==="object"){
    const j=req.body.job;
    job={title:(j.title||"").toString().slice(0,300),company:(j.company||"").toString().slice(0,200),location:(j.location||"").toString().slice(0,200),description:(j.description||"").toString().slice(0,4000),requirements:Array.isArray(j.requirements)?j.requirements.map(String).slice(0,20):[]};
    if(!job.title) return res.status(400).json({success:false,error:"Job title is required for job-specific preparation."});
  }
  const result=await analyzeInterviewPreparation({profile,cvText,cvAnalysis,skillGap,careerPath,jobMatch,job,targetRole});
  const doc=await InterviewPreparation.create({
   userId,targetRole:result.targetRole||targetRole,
   jobId:job?.id||jobMatch?.jobId||"",jobTitle:result.jobTitle||job?.title||"",company:result.company||job?.company||"",
   preparationType: job||jobMatch?"job-specific":"general",
   summary:result.summary,readiness:result.readiness,focusAreas:result.focusAreas,
   questions:result.questions,answerGuidance:result.answerGuidance,skillFocus:result.skillFocus,
   behavioralTopics:result.behavioralTopics,studyPlan:result.studyPlan,nextSteps:result.nextSteps
  });
  return res.status(201).json({success:true,data:{preparation:doc}});
 }catch(e){
  const code=e.statusCode||500;
  return res.status(code).json({success:false,error:e.message||"Interview preparation failed.",code:e.code||undefined});
 }
}
async function list(req,res){
 const p=Math.max(1,parseInt(req.query.page,10)||1);
 const l=Math.min(50,Math.max(1,parseInt(req.query.limit,10)||20));
 const total=await InterviewPreparation.countDocuments({userId:req.user._id});
 const items=await InterviewPreparation.find({userId:req.user._id}).sort({createdAt:-1}).skip((p-1)*l).limit(l);
 return res.json({success:true,data:{preparations:items,pagination:{page:p,limit:l,total,pages:Math.ceil(total/l)||1}}});
}
async function getOne(req,res){
 if(!isValid(req.params.id)) return res.status(404).json({success:false,error:"Interview preparation not found."});
 const doc=await InterviewPreparation.findOne({_id:req.params.id,userId:req.user._id});
 if(!doc) return res.status(404).json({success:false,error:"Interview preparation not found."});
 return res.json({success:true,data:{preparation:doc}});
}
async function remove(req,res){
 if(!isValid(req.params.id)) return res.status(404).json({success:false,error:"Interview preparation not found."});
 const doc=await InterviewPreparation.findOneAndDelete({_id:req.params.id,userId:req.user._id});
 if(!doc) return res.status(404).json({success:false,error:"Interview preparation not found."});
 return res.json({success:true,data:{message:"Deleted."}});
}
module.exports={analyze,list,getOne,remove};
