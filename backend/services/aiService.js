let aiClient = null;
let aiProviderLogged = false;

function getProvider() {
  return (process.env.AI_PROVIDER || "openai").toLowerCase();
}

function getModel() {
  const provider = getProvider();
  if (provider === "groq") return process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  if (provider === "gemini") return process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function logProviderOnce() {
  if (aiProviderLogged) return;
  aiProviderLogged = true;
  const provider = getProvider();
  const model = getModel();
  console.log(`[AI] Provider: ${provider}`);
  console.log(`[AI] Model: ${model}`);
}

function getAIClient() {
  const provider = getProvider();
  if (aiClient && aiClient._provider === provider) return aiClient;

  const OpenAI = require("openai");
  if (provider === "groq") {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
      const err = new Error(
        "The AI service isn't available right now. Please try again later."
      );
      err.statusCode = 503;
      err.code = "AI_NOT_CONFIGURED";
      throw err;
    }
    aiClient = new OpenAI({ apiKey: key, baseURL: "https://api.groq.com/openai/v1" });
    aiClient._provider = "groq";
  } else if (provider === "gemini") {
    aiClient = {
      _provider: "gemini",
      chat: {
        completions: {
          create: async (params) => createGeminiChatCompletion(params),
        },
      },
    };
  } else {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const err = new Error(
        "The AI service isn't available right now. Please try again later."
      );
      err.statusCode = 503;
      err.code = "AI_NOT_CONFIGURED";
      throw err;
    }
    aiClient = new OpenAI({ apiKey: key });
    aiClient._provider = "openai";
  }
  logProviderOnce();
  return aiClient;
}

function getOpenAI() {
  return getAIClient();
}

// ─────────────────────────────────────────────
// Google Gemini adapter (official @google/genai SDK)
// Exposes an OpenAI-compatible chat.completions.create so the six
// feature functions and their schemas remain unchanged.
// The API key is read server-side from process.env.GEMINI_API_KEY only.
// ─────────────────────────────────────────────

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("AI service took too long to respond. Please try again.");
      err.statusCode = 504;
      err.code = "AI_TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function normalizeGeminiJson(text) {
  let s = (text || "").trim().replace(/^\uFEFF/, "");
  let prev;
  do {
    prev = s;
    if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\r?\n?/, "").replace(/```\s*$/, "").trim();
  } while (s !== prev && s.startsWith("`"));
  return s;
}

function extractGeminiText(result) {
  if (result && typeof result.text === "string") return result.text;
  const parts = result && result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts;
  if (Array.isArray(parts)) return parts.map((p) => p.text || "").join("");
  return "";
}

function mapGeminiError(e) {
  if (e && e.statusCode && e.code) throw e;
  let status = (typeof e?.statusCode === "number" && e.statusCode) || (typeof e?.status === "number" && e.status) || 0;
  const cls = (e && e.constructor && e.constructor.name) || "";
  const msg = String(e?.message || "").toLowerCase();
  // Parse @google/genai ApiError message which is a JSON string like {"error":{"code":404,...}}
  let parsedError = null;
  try { parsedError = JSON.parse(msg); } catch {}
  if (parsedError && parsedError.error && typeof parsedError.error.code === "number") {
    status = parsedError.error.code;
  }

  if (status >= 400 && status < 500) {
    const isAuth =
      cls.includes("Authentication") ||
      cls.includes("PermissionDenied") ||
      msg.includes("api key") ||
      msg.includes("apikey") ||
      msg.includes("permission denied") ||
      msg.includes("invalid_api_key");
    const isModelInvalid =
      (cls.includes("NotFound") && msg.includes("model") && msg.includes("not found")) ||
      (typeof parsedCode === "number" && parsedCode === 404 && msg.includes("model"));
    if (isAuth) {
      const err = new Error("The AI service is temporarily unavailable. Please try again shortly.");
      err.statusCode = 503;
      err.code = "AI_AUTH_FAILED";
      throw err;
    }
    if (status === 429 || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource exhausted")) {
      const isQuota = msg.includes("quota") || msg.includes("resource exhausted") || msg.includes("daily") || msg.includes("limit") || msg.includes("billing");
      if (isQuota) {
        const err = new Error(
          "AI analysis is temporarily unavailable because the AI service has reached its usage limit. Your data was submitted successfully. Please try again later."
        );
        err.statusCode = 503;
        err.code = "AI_QUOTA_EXHAUSTED";
        throw err;
      }
      const err = new Error("AI service is temporarily rate-limited. Please try again in a moment.");
      err.statusCode = 429;
      err.code = "AI_RATE_LIMITED";
      throw err;
    }
    if (isModelInvalid) {
      const err = new Error("The AI service is temporarily unavailable. Please try again shortly.");
      err.statusCode = 502;
      err.code = "AI_MODEL_UNAVAILABLE";
      throw err;
    }
  }
  if (cls.includes("Timeout") || cls.includes("Abort") || status >= 500) {
    const err = new Error("AI service is temporarily unavailable. Please try again later.");
    err.statusCode = status >= 500 ? 502 : 504;
    err.code = status >= 500 ? "AI_UNAVAILABLE" : "AI_TIMEOUT";
    throw err;
  }
  if (status) {
    const err = new Error("AI service is temporarily unavailable. Please try again later.");
    err.statusCode = status >= 500 ? 502 : status;
    err.code = "AI_UNAVAILABLE";
    throw err;
  }
// Fallback for raw SDK/network errors (e.g. DNS "fetch failed") — never leak provider details.
  const err = new Error("AI service is temporarily unavailable. Please try again later.");
  err.statusCode = 502;
  err.code = "AI_UNAVAILABLE";
  throw err;
}

async function createGeminiChatCompletion(params) {
  const { GoogleGenAI } = require("@google/genai");
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "PASTE_THE_GEMINI_KEY_HERE") {
    const err = new Error(
      "The AI service isn't available right now. Please try again later."
    );
    err.statusCode = 503;
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  const client = new GoogleGenAI({ apiKey: key });
  const systemText = [];
  const userText = [];
  for (const m of params.messages || []) {
    if (m.role === "system") systemText.push(m.content);
    else if (m.content) userText.push(m.content);
  }
  const contents = [...systemText, ...userText].join("\n\n");

  const config = {};
  if (typeof params.temperature === "number") config.temperature = params.temperature;
  if (typeof params.max_tokens === "number") config.maxOutputTokens = params.max_tokens;
  if (params.response_format && params.response_format.type === "json_object") config.responseMimeType = "application/json";

  let result = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await withTimeout(
        client.models.generateContent({
          model: params.model,
          contents,
          config: Object.keys(config).length ? config : undefined,
        }),
        120000
      );
      break;
    } catch (raw) {
      let mapped;
      try {
        mapGeminiError(raw);
      } catch (m) {
        mapped = m;
      }
      if (!mapped) mapped = raw;
      const retriable =
        mapped && (mapped.code === "AI_UNAVAILABLE" || mapped.code === "AI_RATE_LIMITED" || mapped.code === "AI_TIMEOUT");
      if (!retriable || attempt >= 3) throw mapped;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  let content = extractGeminiText(result);
  if (typeof content !== "string" || content.trim().length === 0) {
    const err = new Error("The AI service didn't send anything back. Please try again.");
    err.statusCode = 502;
    err.code = "AI_EMPTY_RESPONSE";
    throw err;
  }
  if (params.response_format && params.response_format.type === "json_object") {
    content = normalizeGeminiJson(content);
    if (content.length === 0) {
      const err = new Error("The AI service sent an unexpected response. Please try again.");
      err.statusCode = 502;
      throw err;
    }
  }
  return { choices: [{ message: { content } }] };
}

const ANALYSIS_SCHEMA_HINT = `Return ONLY valid JSON with this exact structure:
{
  "overallScore": number (0-100),
  "summary": string (2-3 sentences),
  "detectedSkills": string[],
  "detectedKeywords": string[],
  "missingKeywords": string[] (only if job description provided, else []),
  "strengths": string[],
  "weaknesses": string[],
  "formattingIssues": string[],
  "experienceIssues": string[],
  "achievementSuggestions": string[],
  "bulletPointImprovements": [{"current": string, "suggested": string, "reason": string}],
  "atsRecommendations": string[],
  "jobMatch": null | {"matchingSkills": string[], "missingSkills": string[], "matchingKeywords": string[], "missingKeywords": string[], "relevantExperience": string, "areasToImprove": string[]}
}`;

function buildPrompt(cvText, jobDescription, profile) {
  const profileCtx = profile
    ? `User profile context (targetRole: ${profile.targetRole || "n/a"}, skills: ${(profile.skills || []).join(", ") || "n/a"}, location: ${profile.location || "n/a"})`
    : "";
  const jdSection = jobDescription
    ? `TARGET JOB DESCRIPTION:\n${jobDescription.slice(0, 8000)}\n\nCompare CV ↔ Job Description and populate jobMatch + missingKeywords.`
    : "No job description provided. Set jobMatch to null and missingKeywords to []. Do general optimization.";

  return `You are a career CV reviewer for Nigerian job seekers. Analyze the CV truthfully. Never invent qualifications. Use ATS compatibility language (not "ATS approved").

${profileCtx}

CV TEXT:
${cvText.slice(0, 12000)}

${jdSection}

${ANALYSIS_SCHEMA_HINT}

Rules:
- overallScore 0-100 based on clarity, achievements, keywords, formatting.
- bulletPointImprovements: pick 2-5 weak bullets from CV, rewrite in active voice, same facts.
- atsRecommendations: formatting/readability, keyword coverage, section headings — never claim ATS approved.
- If no job description, jobMatch must be null.`;
}

function mapOpenAIError(e) {
  // Already mapped app errors
  if (e && e.statusCode && e.code) throw e;
  const status = e?.status || e?.statusCode;
  const rawCode = e?.code || e?.error?.code || "";
  const rawType = e?.error?.type || e?.type || "";
  const rawMessage = (e?.error?.message || e?.message || "").toLowerCase();
  // Parse @google/genai ApiError message which is a JSON string like {"error":{"code":404,...}}
  let parsedError = null;
  try { parsedError = JSON.parse(rawMessage); } catch {}
  const parsedCode = parsedError && parsedError.error && parsedError.error.code;
  const effectiveStatus = status || (typeof parsedCode === "number" ? parsedCode : 0);

  const isQuota =
    rawCode === "insufficient_quota" ||
    rawType === "insufficient_quota" ||
    rawCode === "credit_balance_exhausted" ||
    rawMessage.includes("credit_balance_exhausted") ||
    rawMessage.includes("insufficient_quota") ||
    rawMessage.includes("billing") ||
    rawMessage.includes("quota");

  if (effectiveStatus === 429 && isQuota) {
    const err = new Error(
      "AI analysis is temporarily unavailable because the AI service has reached its usage limit. Your CV was uploaded successfully. Please try again later."
    );
    err.statusCode = 503;
    err.code = "AI_QUOTA_EXHAUSTED";
    throw err;
  }
  if (effectiveStatus === 429) {
    const err = new Error("AI service is temporarily rate-limited. Please try again in a moment.");
    err.statusCode = 429;
    err.code = "AI_RATE_LIMITED";
    throw err;
  }
  if (effectiveStatus === 401 || rawCode === "invalid_api_key" || rawType === "invalid_request_error" && rawMessage.includes("api key")) {
    const err = new Error("The AI service is temporarily unavailable. Please try again shortly.");
    err.statusCode = 503;
    err.code = "AI_AUTH_FAILED";
    throw err;
  }
  // Generic OpenAI failure - hide raw details
  if (effectiveStatus) {
    const err = new Error("AI service is temporarily unavailable. Please try again later.");
    err.statusCode = effectiveStatus >= 500 ? 502 : effectiveStatus;
    err.code = "AI_UNAVAILABLE";
    throw err;
  }
  throw e;
}

async function analyzeCV(cvText, jobDescription, profile) {
  const client = getOpenAI();
  const model = getModel();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a helpful CV analysis assistant. Return only JSON." },
        { role: "user", content: buildPrompt(cvText, jobDescription, profile) },
      ],
      max_tokens: 3000,
    });
  } catch (e) {
    mapOpenAIError(e);
  }

  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error("The AI service sent an unexpected response. Please try again.");
    err.statusCode = 502;
    throw err;
  }

  // Normalize and validate shape
  return {
    overallScore: Math.min(100, Math.max(0, Number(parsed.overallScore) || 0)),
    summary: String(parsed.summary || ""),
    detectedSkills: Array.isArray(parsed.detectedSkills) ? parsed.detectedSkills : [],
    detectedKeywords: Array.isArray(parsed.detectedKeywords) ? parsed.detectedKeywords : [],
    missingKeywords: Array.isArray(parsed.missingKeywords) ? parsed.missingKeywords : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
    formattingIssues: Array.isArray(parsed.formattingIssues) ? parsed.formattingIssues : [],
    experienceIssues: Array.isArray(parsed.experienceIssues) ? parsed.experienceIssues : [],
    achievementSuggestions: Array.isArray(parsed.achievementSuggestions) ? parsed.achievementSuggestions : [],
    bulletPointImprovements: Array.isArray(parsed.bulletPointImprovements) ? parsed.bulletPointImprovements : [],
    atsRecommendations: Array.isArray(parsed.atsRecommendations) ? parsed.atsRecommendations : [],
    jobMatch: parsed.jobMatch || null,
    _model: model,
  };
}

async function optimizeCV(cvText, analysis, jobDescription) {
  const client = getOpenAI();
  const model = getModel();

  const prompt = `Rewrite this CV to be stronger based on the analysis.

ABSOLUTE FIDELITY RULES — these override every stylistic instinct and every example you have ever seen of a CV:
1. Use ONLY information that is explicitly written in the CV TEXT below, or explicitly supplied in the JOB DESCRIPTION or ANALYSIS. Nothing else is a permitted source.
2. NEVER invent, assume, infer, guess, complete or fabricate any of the following:
   - names, phone numbers, email addresses, or any contact detail
   - LinkedIn URLs, GitHub URLs, portfolio URLs, or ANY other link/URL
   - schools, degrees, fields of study, or graduation years
   - certifications, licences or course names
   - employers, company names, job titles or designations
   - dates, years of experience or durations
   - skills, tools or technologies
   - achievements, responsibilities or projects
   - metrics, percentages or numbers
   - locations, addresses or country/city names
3. Do NOT use placeholder values. Never output things like "linkedin.com/in/yourname", "github.com/yourname", "yourportfolio.com", "[Add education here]", "N/A", "TBD", "XXXX", or any bracketed/fill-in-the-blank marker.
4. Output ONLY the sections that actually exist in the CV TEXT, using the SAME section names the source CV uses. If the source CV has no education, certifications, projects, summary or contact block, OMIT that section entirely — do not create it, do not add an empty one, and do not add a generic one. Never add a section just because CVs usually have it.
5. If a fact is missing or uncertain, leave it out. Omission is always correct; guessing is always wrong.
6. You MAY rewrite and reorder existing content, improve grammar, convert to active voice, tighten wording, improve structure/formatting and ATS readability, and keep every original heading and every original fact intact.
7. You MAY rewrite an existing bullet point, but you must preserve its original meaning and must not attach any number, metric or outcome that the original bullet did not state. If the original bullet has no metric, the rewritten bullet must have no metric.
8. Keep the candidate's original name and contact details exactly as written, character for character. Do not correct, expand, translate or reformat them.

CV TEXT:
${cvText.slice(0, 12000)}

ANALYSIS:
${JSON.stringify(analysis).slice(0, 6000)}

${jobDescription ? `JOB DESCRIPTION (use only to guide wording and keyword choice, never as a source of candidate facts):\n${jobDescription.slice(0, 6000)}` : ""}

Return ONLY the optimized CV as plain text. Reproduce only sections and facts that exist in the CV TEXT above. Do not add commentary, notes, brackets or explanations outside the CV.`;

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: "You are a CV optimization assistant. You improve wording, structure, formatting and ATS compatibility while preserving factual accuracy with absolute strictness. You use ONLY facts explicitly present in the candidate's CV. You never invent, infer, complete or placeholder any name, contact detail, URL, link, school, degree, certification, employer, job title, date, duration, skill, achievement, metric, number or location. You never output an example or sample URL. If a section or fact is absent from the source CV, you omit it rather than inventing it. You never add a generic or placeholder section. You return only the optimized CV text and nothing else."
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 3500,
    });
  } catch (e) {
    mapOpenAIError(e);
  }

  return (completion.choices[0]?.message?.content || "").trim();
}

const SKILL_GAP_SCHEMA_HINT = `Return ONLY valid JSON with this exact structure:
{
  "targetRole": string,
  "overallReadiness": number (0-100),
  "summary": string (2-3 sentences),
  "currentSkills": string[],
  "requiredSkills": string[],
  "skillGaps": [{"skill": string, "priority": "High"|"Medium"|"Low", "reason": string, "recommendedAction": string}],
  "strengths": string[],
  "roadmap": [{"stage": number, "title": string, "skills": string[], "actions": string[], "projectIdea": string}]
}`;

function buildSkillGapPrompt({ targetRole, profile, cvText, cvAnalysis }) {
  const profileBlock = profile
    ? `CAREER PROFILE:
- targetRole: ${profile.targetRole || "n/a"}
- education: ${(profile.education || "").slice(0, 1500) || "n/a"}
- skills: ${(profile.skills || []).join(", ") || "n/a"}
- experience: ${(profile.experience || "").slice(0, 2000) || "n/a"}
- projects: ${(profile.projects || "").slice(0, 1500) || "n/a"}
- goals: ${(profile.goals || "").slice(0, 1000) || "n/a"}
- location: ${profile.location || "n/a"}`
    : "CAREER PROFILE: n/a";

  const cvBlock = cvText
    ? `CV EXTRACTED TEXT:\n${cvText.slice(0, 8000)}\n\n${
        cvAnalysis
          ? `CV PRIOR ANALYSIS (for context, do not blindly copy missingKeywords as gaps):\n${JSON.stringify(cvAnalysis).slice(0, 4000)}`
          : ""
      }`
    : "CV: not provided (analyze using profile only)";

  return `You are a career skill-gap analyst for Nigerian job seekers. Compare the user's CURRENT CAPABILITIES against TARGET ROLE REQUIREMENTS and produce a practical, truthful gap analysis.

TARGET ROLE: ${targetRole}

${profileBlock}

${cvBlock}

${SKILL_GAP_SCHEMA_HINT}

STRICT RULES:
- Do NOT invent qualifications, experience, certifications, projects, employment, or skills the user did not provide.
- If information is missing, acknowledge it is missing — do not assume mastery.
- Distinguish: skills the user explicitly reports vs skills detected from CV vs skills required by target role. Do not claim user has a skill merely because target role requires it.
- Do not treat every job description keyword as a universal requirement; interpret missingKeywords in context of target role.
- Prioritize skillGaps by: importance to target role, current evidence, learning dependency, practical usefulness. Limit to 4-7 most important gaps.
- Roadmap: 2-4 stages, each with focused skills, practical actions, and one project idea. Do not promise unrealistic timelines.
- This is career guidance, not a guarantee of employability.
- overallReadiness is an AI-generated readiness estimate (0-100), not an employment probability.`;
}

async function analyzeSkillGap(input) {
  const client = getOpenAI();
  const model = getModel();
  const prompt = buildSkillGapPrompt(input);
  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a helpful skill-gap analysis assistant. Return only JSON. Never invent user qualifications." },
        { role: "user", content: prompt },
      ],
      max_tokens: 3000,
    });
  } catch (e) {
    mapOpenAIError(e);
  }
  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error("The AI service sent an unexpected response. Please try again.");
    err.statusCode = 502;
    throw err;
  }
  return {
    targetRole: String(parsed.targetRole || input.targetRole || ""),
    overallReadiness: Math.min(100, Math.max(0, Number(parsed.overallReadiness) || 0)),
    summary: String(parsed.summary || ""),
    currentSkills: Array.isArray(parsed.currentSkills) ? parsed.currentSkills : [],
    requiredSkills: Array.isArray(parsed.requiredSkills) ? parsed.requiredSkills : [],
    skillGaps: Array.isArray(parsed.skillGaps)
      ? parsed.skillGaps.map((g) => ({
          skill: String(g.skill || ""),
          priority: ["High", "Medium", "Low"].includes(g.priority) ? g.priority : "Medium",
          reason: String(g.reason || ""),
          recommendedAction: String(g.recommendedAction || ""),
        })).filter((g) => g.skill)
      : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    roadmap: Array.isArray(parsed.roadmap)
      ? parsed.roadmap.map((r, i) => ({
          stage: Number(r.stage) || i + 1,
          title: String(r.title || `Stage ${i + 1}`),
          skills: Array.isArray(r.skills) ? r.skills : [],
          actions: Array.isArray(r.actions) ? r.actions : [],
          projectIdea: String(r.projectIdea || ""),
        }))
      : [],
    _model: model,
  };
}

const JOB_MATCH_SCHEMA_HINT = `Return ONLY valid JSON with this exact structure:
{
  "matchScore": number (0-100 integer),
  "summary": string (2-3 sentences),
  "matchingSkills": string[],
  "missingSkills": string[],
  "profileAlignment": {"targetRole": string, "experienceAlignment": string, "educationAlignment": string, "locationAlignment": string},
  "reasons": string[],
  "recommendations": string[]
}`;

function buildJobMatchPrompt({ profile, cvText, cvAnalysis, skillGap, job }) {
  const profileBlock = profile
    ? `CAREER PROFILE:
- targetRole: ${profile.targetRole || "n/a"}
- location: ${profile.location || "n/a"}
- education: ${(profile.education || "").slice(0, 1200) || "n/a"}
- skills: ${(profile.skills || []).join(", ") || "n/a"}
- experience: ${(profile.experience || "").slice(0, 1500) || "n/a"}
- projects: ${(profile.projects || "").slice(0, 1200) || "n/a"}
- goals: ${(profile.goals || "").slice(0, 800) || "n/a"}`
    : "CAREER PROFILE: not provided";

  const cvBlock = cvText
    ? `CV EXTRACTED TEXT (truncated):\n${cvText.slice(0, 6000)}\n${cvAnalysis ? `CV ANALYSIS CONTEXT: ${JSON.stringify(cvAnalysis).slice(0, 3000)}` : ""}`
    : "CV: not provided";

  const skillGapBlock = skillGap
    ? `MOST RECENT SKILL-GAP ANALYSIS (targetRole: ${skillGap.targetRole}, readiness: ${skillGap.overallReadiness}%):
- currentSkills: ${(skillGap.currentSkills || []).join(", ") || "n/a"}
- skillGaps: ${JSON.stringify((skillGap.skillGaps || []).slice(0, 5))}
- summary: ${skillGap.summary || "n/a"}`
    : "SKILL-GAP: not provided";

  const jobBlock = `JOB LISTING:
- title: ${job.title || "n/a"}
- company: ${job.company || "n/a"}
- location: ${job.location || "n/a"}
- description: ${(job.description || "").slice(0, 4000) || "n/a"}
- requirements: ${(job.requirements || []).join("; ").slice(0, 1000) || "n/a"}`;

  return `You are an AI job-matching analyst for Nigerian job seekers. Compare the candidate's available information against the job listing and produce a truthful compatibility estimate.

${profileBlock}

${cvBlock}

${skillGapBlock}

${jobBlock}

${JOB_MATCH_SCHEMA_HINT}

STRICT RULES:
- NEVER invent qualifications, degrees, certifications, years of experience, projects, skills, or achievements not present in the provided information.
- If information is unavailable, explicitly state it is unavailable (e.g., "Experience alignment could not be fully assessed because the available profile does not specify years of experience.").
- matchScore is an AI-generated compatibility estimate (0-100), NOT a probability of being hired/selected.
- Distinguish matching vs missing skills based only on evidence in profile/CV/skillGap.
- If job title is unrelated to targetRole, explain the mismatch rather than pretending it is a strong match.
- Recommendations must be grounded in actual gaps (e.g., suggest strengthening SQL only if SQL is missing and relevant).
- Be concise, practical, and honest.`;
}

async function analyzeJobMatch({ profile, cvText, cvAnalysis, skillGap, job }) {
  const client = getOpenAI();
  const model = getModel();
  const prompt = buildJobMatchPrompt({ profile, cvText, cvAnalysis, skillGap, job });
  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a helpful job-matching assistant. Return only JSON. Never invent candidate qualifications." },
        { role: "user", content: prompt },
      ],
      max_tokens: 2500,
    });
  } catch (e) {
    mapOpenAIError(e);
  }
  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err = new Error("The AI service sent an unexpected response. Please try again.");
    err.statusCode = 502;
    throw err;
  }
  return {
    matchScore: Math.min(100, Math.max(0, Math.round(Number(parsed.matchScore) || 0))),
    summary: String(parsed.summary || ""),
    matchingSkills: Array.isArray(parsed.matchingSkills) ? parsed.matchingSkills : [],
    missingSkills: Array.isArray(parsed.missingSkills) ? parsed.missingSkills : [],
    profileAlignment: {
      targetRole: String(parsed.profileAlignment?.targetRole || ""),
      experienceAlignment: String(parsed.profileAlignment?.experienceAlignment || ""),
      educationAlignment: String(parsed.profileAlignment?.educationAlignment || ""),
      locationAlignment: String(parsed.profileAlignment?.locationAlignment || ""),
    },
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    _model: model,
  };
}

const CAREER_PATH_SCHEMA_HINT = `Return ONLY valid JSON with this exact structure:
{
  "targetRole": string,
  "startingPoint": string,
  "destinationRole": string,
  "readiness": number (0-100),
  "summary": string (2-3 sentences),
  "currentSkills": string[],
  "stages": [{"stage": number, "title": string, "objective": string, "skills": string[], "actions": string[], "projectIdeas": string[], "experienceIdeas": string[], "estimatedDuration": string, "milestone": string}],
  "milestones": [{"title": string, "description": string, "skills": string[], "completionCriteria": string}],
  "alternativeRoles": [{"title": string, "reason": string}],
  "nextSteps": string[]
}`;

function buildCareerPathPrompt({ profile, cvText, cvAnalysis, skillGap, jobMatches, targetRole }) {
  const profileBlock = profile ? `CAREER PROFILE:
- targetRole: ${profile.targetRole || "n/a"}
- education: ${(profile.education || "").slice(0,1200) || "n/a"}
- skills: ${(profile.skills||[]).join(", ")||"n/a"}
- experience: ${(profile.experience||"").slice(0,1500)||"n/a"}
- projects: ${(profile.projects||"").slice(0,1200)||"n/a"}
- goals: ${(profile.goals||"").slice(0,800)||"n/a"}
- location: ${profile.location||"n/a"}
- salaryExpectation: ${profile.salaryExpectation||"n/a"}` : "CAREER PROFILE: not provided";
  const cvBlock = cvText ? `CV EXTRACTED TEXT:\n${cvText.slice(0,6000)}\n${cvAnalysis ? `CV ANALYSIS: ${JSON.stringify(cvAnalysis).slice(0,3000)}` : ""}` : "CV: not provided";
  const skillGapBlock = skillGap ? `LATEST SKILL-GAP (targetRole:${skillGap.targetRole}, readiness:${skillGap.overallReadiness}%):
- currentSkills: ${(skillGap.currentSkills||[]).join(", ")}
- skillGaps: ${JSON.stringify((skillGap.skillGaps||[]).slice(0,6))}
- summary: ${skillGap.summary||"n/a"}` : "SKILL-GAP: not provided";
  const jobMatchBlock = jobMatches && jobMatches.length ? `RECENT JOB MATCHES (for recurring requirements):
${jobMatches.slice(0,5).map(j=>`- ${j.jobTitle} @ ${j.company}: missing [${(j.missingSkills||[]).join(", ")}] matching [${(j.matchingSkills||[]).join(", ")}]`).join("\n")}` : "JOB MATCHES: none";
  return `You are a career path analyst for Nigerian job seekers. Build a practical, truthful progression from the user's current state to the target role.

DESIRED TARGET ROLE: ${targetRole}

${profileBlock}

${cvBlock}

${skillGapBlock}

${jobMatchBlock}

${CAREER_PATH_SCHEMA_HINT}

STRICT RULES:
- NEVER invent degrees, certifications, years of experience, projects, skills, employment not in provided data. Distinguish what user HAS vs NEEDS vs Morine RECOMMENDS.
- readiness is AI-generated career readiness estimate (0-100), NOT employment probability. Do not guarantee employment.
- Stages 3-6, practical order: foundations -> job-ready skills -> portfolio evidence -> experience building -> application readiness. Adapt to user, include estimatedDuration.
- Transform skill gaps into ordered roadmap, use recurring job requirements only if present in jobMatches.
- Provide actionable nextSteps (3-5).
- Be concise, Nigerian context aware.`;
}

async function analyzeCareerPath(input) {
  const client = getOpenAI();
  const model = getModel();
  const prompt = buildCareerPathPrompt(input);
  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a helpful career path analyst. Return only JSON. Never invent user qualifications." },
        { role: "user", content: prompt },
      ],
      max_tokens: 3500,
    });
  } catch (e) {
    // Generic quota message for career path
    try { mapOpenAIError(e); } catch (mapped) {
      if (mapped.code === "AI_QUOTA_EXHAUSTED") {
        const err = new Error("Career path generation is temporarily unavailable because the AI service has reached its usage limit. Your profile and existing career data are still safe.");
        err.statusCode = 503;
        err.code = "AI_QUOTA_EXHAUSTED";
        throw err;
      }
      throw mapped;
    }
  }
  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { const err=new Error("The AI service sent an unexpected response. Please try again."); err.statusCode=502; throw err; }
  return {
    targetRole: String(parsed.targetRole || input.targetRole || ""),
    startingPoint: String(parsed.startingPoint || ""),
    destinationRole: String(parsed.destinationRole || parsed.targetRole || input.targetRole || ""),
    readiness: Math.min(100, Math.max(0, Math.round(Number(parsed.readiness)||0))),
    summary: String(parsed.summary || ""),
    currentSkills: Array.isArray(parsed.currentSkills) ? parsed.currentSkills : [],
    stages: Array.isArray(parsed.stages) ? parsed.stages.map((s,i)=>({
      stage: Number(s.stage)||i+1,
      title: String(s.title||`Stage ${i+1}`),
      objective: String(s.objective||""),
      skills: Array.isArray(s.skills)?s.skills:[],
      actions: Array.isArray(s.actions)?s.actions:[],
      projectIdeas: Array.isArray(s.projectIdeas)?s.projectIdeas:[],
      experienceIdeas: Array.isArray(s.experienceIdeas)?s.experienceIdeas:[],
      estimatedDuration: String(s.estimatedDuration||""),
      milestone: String(s.milestone||""),
    })) : [],
    milestones: Array.isArray(parsed.milestones) ? parsed.milestones.map(m=>({
      title: String(m.title||""),
      description: String(m.description||""),
      skills: Array.isArray(m.skills)?m.skills:[],
      completionCriteria: String(m.completionCriteria||""),
    })).filter(m=>m.title) : [],
    alternativeRoles: Array.isArray(parsed.alternativeRoles) ? parsed.alternativeRoles.map(a=>({
      title: String(a.title||""),
      reason: String(a.reason||""),
    })).filter(a=>a.title) : [],
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
    _model: model,
  };
}

const INTERVIEW_PREP_SCHEMA_HINT=`Return ONLY valid JSON with this exact structure:
{
  "targetRole": string,
  "jobTitle": string,
  "company": string,
  "preparationType": "general"|"job-specific",
  "readiness": number (0-100),
  "summary": string,
  "focusAreas": string[],
  "questions": [{"id": string, "category": "Behavioral"|"Technical"|"Role-specific"|"CV-based"|"Scenario"|"Motivation", "question": string, "whyItMatters": string, "whatToCover": string[], "difficulty": "Easy"|"Medium"|"Hard", "followUpQuestions": string[]}],
  "answerGuidance": [{"questionId": string, "framework": string, "keyPoints": string[], "warningPoints": string[]}],
  "skillFocus": [{"skill": string, "reason": string, "preparationAction": string}],
  "behavioralTopics": string[],
  "studyPlan": [{"stage": number, "title": string, "actions": string[], "resources": string[], "completionCriteria": string}],
  "nextSteps": string[]
}`;

function buildInterviewPrepPrompt({profile,cvText,cvAnalysis,skillGap,careerPath,jobMatch,job,targetRole}){
 const profileBlock=profile?`CAREER PROFILE:
- targetRole: ${profile.targetRole||"n/a"}
- education: ${(profile.education||"").slice(0,1200)||"n/a"}
- skills: ${(profile.skills||[]).join(", ")||"n/a"}
- experience: ${(profile.experience||"").slice(0,1500)||"n/a"}
- projects: ${(profile.projects||"").slice(0,1200)||"n/a"}
- goals: ${(profile.goals||"").slice(0,800)||"n/a"}`:"CAREER PROFILE: not provided";
 const cvBlock=cvText?`CV EXTRACTED TEXT:\n${cvText.slice(0,6000)}\n${cvAnalysis?`CV ANALYSIS: ${JSON.stringify(cvAnalysis).slice(0,2500)}`:""}`:"CV: not provided";
 const skillGapBlock=skillGap?`LATEST SKILL-GAP (targetRole:${skillGap.targetRole}, readiness:${skillGap.overallReadiness}%): currentSkills [${(skillGap.currentSkills||[]).join(", ")}] gaps ${JSON.stringify((skillGap.skillGaps||[]).slice(0,5))}`:"SKILL-GAP: not provided";
 const careerPathBlock=careerPath?`CAREER PATH (targetRole:${careerPath.targetRole}, readiness:${careerPath.readiness}%): stages ${JSON.stringify((careerPath.stages||[]).slice(0,3).map(s=>s.title))} nextSteps [${(careerPath.nextSteps||[]).join("; ")}]`:"CAREER PATH: not provided";
 const jobMatchBlock=jobMatch?`JOB MATCH (title:${jobMatch.jobTitle}, score:${jobMatch.matchScore}%): matching [${(jobMatch.matchingSkills||[]).join(", ")}] missing [${(jobMatch.missingSkills||[]).join(", ")}]`:"JOB MATCH: not provided";
 const jobBlock=job?`TARGET JOB:
- title: ${job.title||"n/a"}
- company: ${job.company||"n/a"}
- location: ${job.location||"n/a"}
- description: ${(job.description||"").slice(0,3500)||"n/a"}
- requirements: ${(job.requirements||[]).join("; ").slice(0,1000)||"n/a"}`:"TARGET JOB: general role preparation (no specific job)";
 return `You are an interview preparation coach for Nigerian job seekers. Create personalized, truthful preparation based ONLY on provided data.

DESIRED ROLE: ${targetRole}

${profileBlock}

${cvBlock}

${skillGapBlock}

${careerPathBlock}

${jobMatchBlock}

${jobBlock}

${INTERVIEW_PREP_SCHEMA_HINT}

STRICT RULES:
- NEVER invent qualifications, degrees, certifications, employment, projects, skills, years of experience not in provided data. Keep facts vs preparation recommendations separate.
- If CV contains "Power BI project" you may ask about it; if not, say "You may be asked about Power BI if required" — never claim experience.
- Questions balanced: Behavioral, Role-specific, Technical/Skill, CV-based (only if CV present), Scenario, Motivation. 8-12 questions.
- Each question: whyItMatters, whatToCover (2-4 points), difficulty, followUpQuestions.
- answerGuidance: framework (STAR/PREP/technical), keyPoints, warningPoints — do NOT write fake personal answers.
- skillFocus based on gaps/missing skills, not invented.
- readiness is AI-generated interview readiness estimate (0-100), NOT hiring probability.
- studyPlan 3-5 stages adapted to user.
- Be concise, Nigerian context, practical.`;
}

async function analyzeInterviewPreparation(input){
 const client=getOpenAI();
 const model=getModel();
 const prompt=buildInterviewPrepPrompt(input);
 let completion;
 try{
  completion=await client.chat.completions.create({
   model,temperature:0.3,response_format:{type:"json_object"},
   messages:[
    {role:"system",content:"You are a helpful interview preparation assistant. Return only JSON. Never invent candidate qualifications."},
    {role:"user",content:prompt}
   ],max_tokens:4000
  });
 }catch(e){
  try{ mapOpenAIError(e);}catch(mapped){
   if(mapped.code==="AI_QUOTA_EXHAUSTED"){
    const err=new Error("Interview preparation is temporarily unavailable because the AI service has reached its usage limit. Your existing career data is safe. Please try again later.");
    err.statusCode=503;err.code="AI_QUOTA_EXHAUSTED";throw err;
   }
   throw mapped;
  }
 }
 const raw=completion.choices[0]?.message?.content||"{}";
 let parsed; try{ parsed=JSON.parse(raw);}catch{ const err=new Error("The AI service sent an unexpected response. Please try again."); err.statusCode=502; throw err; }
 return {
  targetRole:String(parsed.targetRole||input.targetRole||""),
  jobTitle:String(parsed.jobTitle||input.job?.title||""),
  company:String(parsed.company||input.job?.company||""),
  preparationType: parsed.preparationType==="job-specific"?"job-specific":"general",
  readiness:Math.min(100,Math.max(0,Math.round(Number(parsed.readiness)||0))),
  summary:String(parsed.summary||""),
  focusAreas:Array.isArray(parsed.focusAreas)?parsed.focusAreas:[],
  questions:Array.isArray(parsed.questions)?parsed.questions.map((q,i)=>({
   id:String(q.id||`q${i+1}`),
   category:String(q.category||"Role-specific"),
   question:String(q.question||""),
   whyItMatters:String(q.whyItMatters||""),
   whatToCover:Array.isArray(q.whatToCover)?q.whatToCover:[],
   difficulty:["Easy","Medium","Hard"].includes(q.difficulty)?q.difficulty:"Medium",
   followUpQuestions:Array.isArray(q.followUpQuestions)?q.followUpQuestions:[]
  })).filter(q=>q.question):[],
  answerGuidance:Array.isArray(parsed.answerGuidance)?parsed.answerGuidance.map(a=>({
   questionId:String(a.questionId||""),
   framework:String(a.framework||""),
   keyPoints:Array.isArray(a.keyPoints)?a.keyPoints:[],
   warningPoints:Array.isArray(a.warningPoints)?a.warningPoints:[]
  })):[],
  skillFocus:Array.isArray(parsed.skillFocus)?parsed.skillFocus.map(s=>({skill:String(s.skill||""),reason:String(s.reason||""),preparationAction:String(s.preparationAction||"")})).filter(s=>s.skill):[],
  behavioralTopics:Array.isArray(parsed.behavioralTopics)?parsed.behavioralTopics:[],
  studyPlan:Array.isArray(parsed.studyPlan)?parsed.studyPlan.map((s,i)=>({stage:Number(s.stage)||i+1,title:String(s.title||`Stage ${i+1}`),actions:Array.isArray(s.actions)?s.actions:[],resources:Array.isArray(s.resources)?s.resources:[],completionCriteria:String(s.completionCriteria||"")})):[],
  nextSteps:Array.isArray(parsed.nextSteps)?parsed.nextSteps:[],
  _model:model
 };
}

const CAREER_PROFILE_SCHEMA_HINT = `Return ONLY valid JSON with this exact structure:
{
  "headline": string (one line, the candidate's career identity),
  "summary": string (2-4 sentences interpreting the provided data),
  "coreStrengths": [{"title": string, "evidence": string}],
  "careerAreas": string[],
  "transferableSkills": string[],
  "potentialRoles": [{"title": string, "reason": string}],
  "developmentAreas": [{"area": string, "reason": string}],
  "positioning": string,
  "dataGaps": string[],
  "basedOn": string[] (list the data sources actually used)
}`;

function buildCareerProfilePrompt({ profile, cvText, cvAnalysis, skillGap, careerPath, jobMatches }) {
  const profileBlock = profile ? `CAREER PROFILE (user-provided facts):
- targetRole: ${profile.targetRole || "n/a"}
- education: ${(profile.education || "").slice(0, 1200) || "n/a"}
- skills: ${(profile.skills || []).join(", ") || "n/a"}
- experience: ${(profile.experience || "").slice(0, 1500) || "n/a"}
- projects: ${(profile.projects || "").slice(0, 1200) || "n/a"}
- goals: ${(profile.goals || "").slice(0, 800) || "n/a"}
- location: ${profile.location || "n/a"}
- salaryExpectation: ${profile.salaryExpectation || "n/a"}` : "CAREER PROFILE: not provided";
  const cvBlock = cvText ? `CV EXTRACTED TEXT (user-provided facts):\n${cvText.slice(0, 5000)}${cvAnalysis ? `\nCV ANALYSIS: ${JSON.stringify(cvAnalysis).slice(0, 2000)}` : ""}` : "CV: not provided";
  const skillGapBlock = skillGap ? `LATEST SKILL-GAP ANALYSIS (targetRole:${skillGap.targetRole}, readiness:${skillGap.overallReadiness}%):
- currentSkills: ${(skillGap.currentSkills || []).join(", ")}
- skillGaps: ${JSON.stringify((skillGap.skillGaps || []).slice(0, 6))}
- summary: ${skillGap.summary || "n/a"}` : "SKILL-GAP: not provided";
  const careerPathBlock = careerPath ? `LATEST CAREER PATH (AI-generated, targetRole:${careerPath.targetRole}, readiness:${careerPath.readiness}%):
- summary: ${(careerPath.summary || "").slice(0, 600)}
- stages: ${JSON.stringify((careerPath.stages || []).map(s => ({ title: s.title, skills: s.skills })).slice(0, 6))}
- currentSkills: ${(careerPath.currentSkills || []).join(", ")}` : "CAREER PATH: not provided";
  const jobMatchBlock = jobMatches && jobMatches.length ? `RECENT JOB MATCHES (recurring market requirements):
${jobMatches.slice(0, 5).map(j => `- ${j.jobTitle} @ ${j.company}: matching [${(j.matchingSkills || []).join(", ")}] missing [${(j.missingSkills || []).join(", ")}]`).join("\n")}` : "JOB MATCHES: none";
  return `You are a career intelligence analyst for Nigerian job seekers. Produce an AI interpretation of the candidate's career profile using ONLY the data provided below.

${profileBlock}

${cvBlock}

${skillGapBlock}

${careerPathBlock}

${jobMatchBlock}

${CAREER_PROFILE_SCHEMA_HINT}

STRICT RULES:
- This is an AI INTERPRETATION, not a record of fact. Everything you output is an inference drawn from the data above.
- NEVER invent qualifications, degrees, certifications, years of experience, employers, projects, skills, achievements, or any other personal fact. If it is not in the data above, it does not exist for this candidate.
- Every entry in coreStrengths MUST include an "evidence" field that quotes or directly points to the specific provided data that supports it. If you cannot cite evidence, do not list the strength.
- transferableSkills must be traceable to provided experience, projects, education or CV text.
- developmentAreas must be grounded in an actual missing or weak signal in the data (e.g. a skill absent from the profile that recurs in jobMatches).
- potentialRoles are suggestions grounded in the provided skills/education/experience, not job offers and not guarantees.
- Use dataGaps to explicitly state what is missing or could not be assessed (e.g. "No work history provided, so years of experience could not be assessed").
- Do not promise employment, salary, or interview success. Do not claim certifications or compliance the data does not show.
- Be concise, practical, and honest. Nigerian context aware.`;

  }

async function generateCareerProfile(input) {
  const client = getOpenAI();
  const model = getModel();
  const prompt = buildCareerProfilePrompt(input);
  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a career intelligence analyst. Return only JSON. You interpret provided data and must never invent personal facts about the candidate." },
        { role: "user", content: prompt },
      ],
      max_tokens: 3000,
    });
  } catch (e) {
    try { mapOpenAIError(e); } catch (mapped) {
      if (mapped.code === "AI_QUOTA_EXHAUSTED") {
        const err = new Error("AI Career Profile is temporarily unavailable because the AI service has reached its usage limit. Your Profile and saved career data are still safe.");
        err.statusCode = 503;
        err.code = "AI_QUOTA_EXHAUSTED";
        throw err;
      }
      throw mapped;
    }
  }
  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { const err = new Error("The AI service sent an unexpected response. Please try again."); err.statusCode = 502; throw err; }
  const str = v => String(v == null ? "" : v);
  return {
    headline: str(parsed.headline),
    summary: str(parsed.summary),
    coreStrengths: Array.isArray(parsed.coreStrengths)
      ? parsed.coreStrengths.map(s => ({ title: str(s && s.title), evidence: str(s && s.evidence) })).filter(s => s.title && s.evidence)
      : [],
    careerAreas: Array.isArray(parsed.careerAreas) ? parsed.careerAreas.map(str).filter(Boolean) : [],
    transferableSkills: Array.isArray(parsed.transferableSkills) ? parsed.transferableSkills.map(str).filter(Boolean) : [],
    potentialRoles: Array.isArray(parsed.potentialRoles)
      ? parsed.potentialRoles.map(r => ({ title: str(r && r.title), reason: str(r && r.reason) })).filter(r => r.title)
      : [],
    developmentAreas: Array.isArray(parsed.developmentAreas)
      ? parsed.developmentAreas.map(d => ({ area: str(d && d.area), reason: str(d && d.reason) })).filter(d => d.area)
      : [],
    positioning: str(parsed.positioning),
    dataGaps: Array.isArray(parsed.dataGaps) ? parsed.dataGaps.map(str).filter(Boolean) : [],
    basedOn: Array.isArray(parsed.basedOn) ? parsed.basedOn.map(str).filter(Boolean) : [],
    _model: model,
  };
}

module.exports = { analyzeCV, optimizeCV, analyzeSkillGap, analyzeJobMatch, analyzeCareerPath, generateCareerProfile, analyzeInterviewPreparation, chat };

async function chat(messages, profile) {
  const client = getOpenAI();
  const model = getModel();

  const profileBlock = profile
    ? `USER PROFILE (context only — do not invent beyond it):
- targetRole: ${profile.targetRole || "not set"}
- skills: ${(profile.skills || []).join(", ") || "not set"}
- experience: ${(profile.experience || "").slice(0, 800) || "not set"}
- education: ${(profile.education || "").slice(0, 500) || "not set"}
- projects: ${(profile.projects || "").slice(0, 500) || "not set"}
- goals: ${(profile.goals || "").slice(0, 400) || "not set"}`
    : "USER PROFILE: not on file — answer generally.";

  const system = `You are Morine, a concise, practical career AI co-pilot for job seekers. Answer job-search, skill, CV, interview and career-path questions. Be helpful and grounded; when unsure what the user has actually done, ask rather than invent. Keep replies scannable (short sections/bullets), maximum ~250 words, Nigerian job-market aware.

${profileBlock}`;

  const history = Array.isArray(messages)
    ? messages.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 2000),
      })).filter((m) => m.content && m.content.trim())
    : [];

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.5,
      messages: [{ role: "system", content: system }, ...history],
      max_tokens: 900,
    });
  } catch (e) {
    mapOpenAIError(e);
  }

  const reply = (completion?.choices?.[0]?.message?.content || "").trim();
  if (!reply) {
    const err = new Error("The AI service didn't send anything back. Please try again.");
    err.statusCode = 502;
    err.code = "AI_EMPTY_RESPONSE";
    throw err;
  }
  return { reply };
}
