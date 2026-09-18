const mongoose=require("mongoose");
const CareerPath=require("../models/CareerPath");
const CareerProfile=require("../models/CareerProfile");
const CV=require("../models/CV");
const SkillGapAnalysis=require("../models/SkillGapAnalysis");
const JobMatch=require("../models/JobMatch");
const {analyzeCareerPath}=require("../services/aiService");
function isValid(id){return mongoose.Types.ObjectId.isValid(id);}
async function analyze(req,res){
 try{
  const userId=req.user._id;
  const profile=await CareerProfile.findOne({userId}).lean();
  if(!profile) return res.status(400).json({success:false,error:"Please create your Career Profile before generating a career path."});
  let targetRole=(req.body.targetRole||"").toString().trim();
  if(!targetRole) targetRole=(profile.targetRole||"").toString().trim();
  if(!targetRole) return res.status(400).json({success:false,error:"Please add a target role to your Career Profile or provide targetRole in the request."});
  // latest skill gap
  let skillGap=await SkillGapAnalysis.findOne({userId,targetRole}).sort({createdAt:-1}).lean();
  if(!skillGap) skillGap=await SkillGapAnalysis.findOne({userId}).sort({createdAt:-1}).lean();
  // CV optional
  let cvText=""; let cvAnalysis=null;
  if(req.body.cvId){
    const cvId=req.body.cvId.toString();
    if(!isValid(cvId)) return res.status(404).json({success:false,error:"CV not found."});
    const cv=await CV.findOne({_id:cvId,userId});
    if(!cv) return res.status(404).json({success:false,error:"CV not found."});
    cvText=cv.extractedText||""; cvAnalysis=cv.analysis||null;
  } else {
    const cv=await CV.findOne({userId}).sort({createdAt:-1});
    if(cv){ cvText=cv.extractedText||""; cvAnalysis=cv.analysis||null; }
  }
  const jobMatches=await JobMatch.find({userId}).sort({createdAt:-1}).limit(5).lean();
  const result=await analyzeCareerPath({profile,cvText,cvAnalysis,skillGap,jobMatches,targetRole});
  const doc=await CareerPath.create({
    userId,targetRole,
    startingPoint:result.startingPoint,
    destinationRole:result.destinationRole,
    currentSkills:result.currentSkills,
    readiness:result.readiness,
    summary:result.summary,
    stages:result.stages,
    milestones:result.milestones,
    alternativeRoles:result.alternativeRoles,
    nextSteps:result.nextSteps
  });
  return res.status(201).json({success:true,data:{path:doc}});
 }catch(e){
  const code=e.statusCode||500;
  return res.status(code).json({success:false,error:e.message||"Career path failed.",code:e.code||undefined});
 }
}
async function list(req,res){
 const p=Math.max(1,parseInt(req.query.page,10)||1);
 const l=Math.min(50,Math.max(1,parseInt(req.query.limit,10)||20));
 const filter={userId:req.user._id};
 const total=await CareerPath.countDocuments(filter);
 const paths=await CareerPath.find(filter).sort({createdAt:-1}).skip((p-1)*l).limit(l);
 return res.json({success:true,data:{paths,pagination:{page:p,limit:l,total,pages:Math.ceil(total/l)||1}}});
}
async function getOne(req,res){
 if(!isValid(req.params.id)) return res.status(404).json({success:false,error:"Career path not found."});
 const doc=await CareerPath.findOne({_id:req.params.id,userId:req.user._id});
 if(!doc) return res.status(404).json({success:false,error:"Career path not found."});
 return res.json({success:true,data:{path:doc}});
}
async function remove(req,res){
 if(!isValid(req.params.id)) return res.status(404).json({success:false,error:"Career path not found."});
 const doc=await CareerPath.findOneAndDelete({_id:req.params.id,userId:req.user._id});
 if(!doc) return res.status(404).json({success:false,error:"Career path not found."});
 return res.json({success:true,data:{message:"Career path deleted."}});
}
module.exports={analyze,list,getOne,remove};
