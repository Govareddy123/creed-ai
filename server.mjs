import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set. The UI will start, but reviews will fail until the key is configured.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 25 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/tiff"
    ];
    if (allowed.includes(file.mimetype) || /\.(pdf|png|jpe?g|webp|tiff?)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and image files are supported."));
    }
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const CHECKS = [
  {
    key: "CAQH",
    instruction: "Find CAQH evidence and assess presence, provider identity consistency, relevant identifiers, specialty/provider information, and obvious completeness issues."
  },
  {
    key: "NPI",
    instruction: "Find NPI evidence and assess NPI number, provider identity, taxonomy/provider type where present, and consistency with the rest of the packet."
  },
  {
    key: "LICENSE",
    instruction: "Find professional license evidence. Assess state, license number, name, status, issue/expiration dates, and whether the license appears current. Do not invent verification outside the supplied packet."
  },
  {
    key: "BOARDCERT",
    instruction: "Find board certification evidence. Assess certifying body, provider name, specialty, certification dates/status, and consistency with provider type."
  },
  {
    key: "PLI",
    instruction: "Find professional liability/malpractice evidence. Assess provider name, carrier, policy/certificate number when present, effective/expiration dates, and coverage/limits when shown. Do not assume a limit requirement unless supplied."
  },
  {
    key: "WORK HISTORY",
    instruction: "Review CV/work-history evidence for chronology, employer/facility names, dates, unexplained gaps, overlaps, and consistency with other documents. Do not call a gap a defect if the dates are unclear; use VERIFY."
  },
  {
    key: "NPDB",
    instruction: "Find NPDB evidence/report. Assess whether the expected report/document is present and whether the provider identity matches."
  },
  {
    key: "DOCUMENTS",
    instruction: "Assess whether the packet contains the expected supporting credentialing documents visible in the supplied files. List important missing or unreadable documents rather than assuming a universal document list."
  },
  {
    key: "PROVIDER TYPE",
    instruction: "Determine the provider type/specialty represented by the packet and check consistency across CAQH, NPI/taxonomy, licenses, board certification, CV, and other documents."
  },
  {
    key: "ALIAS NAMES",
    instruction: "This is a cross-document alias check. Extract every provider name variant/alias found in CAQH, NPI, professional licenses, supporting documents, and BoardCert. Compare them. Distinguish harmless formatting differences (middle initial, punctuation, suffix) from meaningful discrepancies. Report every meaningful mismatch with source filenames and page numbers when available. Never invent an alias."
  },
  {
    key: "START DATE",
    instruction: "Check the case initiation/start date. Only PASS if a reliable case-start/initiation date is explicitly available in supplied packet content or case metadata. Do not substitute upload date or today's date. If no case-start date is available, use NEEDS_DATA."
  },
  {
    key: "COMPLETION DATE",
    instruction: "Check the packet-created/completion date. Only PASS if a reliable packet-created/completion date is explicitly available in supplied packet content or case metadata. Do not substitute today's date unless the UI/backend explicitly supplies it as the packet creation date. If unavailable, use NEEDS_DATA."
  }
];

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    packet_type: { type: "string", enum: ["CREDENTIALING_PACKET", "NOT_CREDENTIALING_PACKET", "UNCERTAIN"] },
    packet_confidence: { type: "number", minimum: 0, maximum: 1 },
    packet_reason: { type: "string" },
    provider_name: { type: "string" },
    provider_type: { type: "string" },
    overall_status: { type: "string", enum: ["PASS", "WARN", "FAIL", "NEEDS_DATA"] },
    overall_summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          checklist_item: {
            type: "string",
            enum: CHECKS.map(x => x.key)
          },
          status: {
            type: "string",
            enum: ["PASS", "WARN", "FAIL", "NEEDS_DATA", "NOT_APPLICABLE"]
          },
          summary: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                filename: { type: "string" },
                page: { type: "string" },
                quote_or_fact: { type: "string" }
              },
              required: ["filename", "page", "quote_or_fact"]
            }
          },
          action: { type: "string" }
        },
        required: ["checklist_item", "status", "summary", "evidence", "action"]
      }
    },
    missing_or_unreadable_documents: {
      type: "array",
      items: { type: "string" }
    },
    alias_names: {
      type: "array",
      items: { type: "string" }
    },
    name_variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          sources: { type: "array", "items": { type: "string" } }
        },
        required: ["name", "sources"]
      }
    }
  },
  required: [
    "packet_type","packet_confidence","packet_reason","provider_name","provider_type",
    "overall_status","overall_summary","findings","missing_or_unreadable_documents",
    "alias_names","name_variants"
  ]
};

const SYSTEM_PROMPT = `
You are CredReview AI, a credentialing-packet review assistant.

Your job is to REVIEW ONLY the files supplied by the user and produce an auditable, evidence-based credentialing review.

CRITICAL SAFETY/ACCURACY RULES:
1. First classify the upload as a credentialing packet. Academic records, B.Tech results, transcripts, mark sheets, resumes without credentialing evidence, invoices, unrelated PDFs, etc. are NOT credentialing packets.
2. If packet_type is NOT_CREDENTIALING_PACKET, every checklist finding MUST be FAIL or NOT_APPLICABLE; never mark credentialing checks PASS.
3. If packet_type is UNCERTAIN, do not guess. Use NEEDS_DATA/NOT_APPLICABLE as appropriate.
4. Never fabricate a credential, identifier, date, license status, alias, document, or verification.
5. A PASS requires evidence from the supplied files. If evidence is absent or unreadable, use NEEDS_DATA rather than PASS.
6. A WARN is for a plausible issue that needs human verification. FAIL is for a clear missing, expired, contradictory, or invalid item based on the supplied evidence.
7. For ALIAS NAMES, compare names across CAQH, NPI, licenses, documents, and BoardCert. Do not treat punctuation/case/middle-initial formatting alone as a meaningful mismatch.
8. START DATE means the date the case was initiated. COMPLETION DATE means the date the packet was created/completed. These are workflow metadata, not arbitrary dates found in a credential. Never use today's date as a substitute.
9. Evidence must identify the filename and page where possible. For image files, use page "image". For PDF files, use the PDF page number if you can determine it. If exact page cannot be determined, say "unknown" rather than inventing one.
10. Do not claim that you checked an external database, payer, CAQH, NPI registry, NPDB, licensing board, or BoardCert website unless such data was actually supplied to you in the files. This application is a packet-review tool, not an external verification service.
11. If a document is present but unreadable, say so.
12. Return exactly one finding per checklist item in the supplied checklist, but if the UI selected fewer items, review only those items.
13. Be conservative: the goal is to assist a human credentialing specialist, not silently approve a provider.

CHECKLIST DEFINITIONS:
${CHECKS.map((c, i) => `${i + 1}. ${c.key}: ${c.instruction}`).join("\n")}
`;

function selectedChecks(raw) {
  const requested = Array.isArray(raw) ? raw : CHECKS.map(c => c.key);
  const valid = new Set(CHECKS.map(c => c.key));
  return CHECKS.filter(c => requested.includes(c.key) && valid.has(c.key));
}

async function uploadToOpenAI(file) {
  const uploaded = await openai.files.create({
    file: new File([file.buffer], file.originalname, { type: file.mimetype }),
    purpose: "user_data"
  });
  return uploaded;
}

function buildInput(uploadedFiles, selected, metadata) {
  const fileParts = uploadedFiles.map(f => ({
    type: "input_file",
    file_id: f.id
  }));

  const checklistText = selected.map(c => `- ${c.key}: ${c.instruction}`).join("\n");
  const metadataText = JSON.stringify(metadata || {}, null, 2);

  return [{
    role: "user",
    content: [
      {
        type: "input_text",
        text: `
Review this credentialing packet.

SELECTED CHECKLIST:
${checklistText}

CASE METADATA (may be empty; never invent missing values):
${metadataText}

Return structured evidence for the selected checklist items.
If the files are unrelated to credentialing, reject the packet instead of reviewing it as if it were credentialing material.
`
      },
      ...fileParts
    ]
  }];
}

async function runReview(files, selected, metadata) {
  const uploaded = [];
  try {
    for (const file of files) {
      uploaded.push(await uploadToOpenAI(file));
    }

    const response = await openai.responses.create({
      model: MODEL,
      store: false,
      input: buildInput(uploaded, selected, metadata),
      instructions: SYSTEM_PROMPT,
      text: {
        format: {
          type: "json_schema",
          name: "credential_review",
          strict: true,
          schema: REVIEW_SCHEMA
        }
      }
    });

    const text = response.output_text;
    if (!text) throw new Error("The model returned no structured output.");
    const result = JSON.parse(text);

    // Backend enforcement: if the model says the packet is not credentialing,
    // prevent accidental PASS results from leaking through.
    if (result.packet_type !== "CREDENTIALING_PACKET") {
      result.findings = (result.findings || []).map(f => ({
        ...f,
        status: f.status === "PASS" ? "FAIL" : f.status,
        summary: f.status === "PASS"
          ? "Review blocked because the uploaded files were not classified as a credentialing packet."
          : f.summary
      }));
    }

    return {
      ...result,
      model: MODEL,
      response_id: response.id,
      reviewed_files: files.map(f => f.originalname)
    };
  } finally {
    // Keep uploaded OpenAI files short-lived from the application's perspective.
    // We explicitly delete them after the response because the packet may contain
    // sensitive provider information.
    for (const f of uploaded) {
      try { await openai.files.delete(f.id); } catch (_) {}
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: MODEL,
    checklist: CHECKS.map(x => x.key)
  });
});

app.post("/api/review", upload.array("packet", 25), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
    }
    if (!req.files?.length) {
      return res.status(400).json({ error: "Upload at least one PDF or image file." });
    }

    const selected = selectedChecks(
      req.body.checklist ? JSON.parse(req.body.checklist) : CHECKS.map(x => x.key)
    );

    if (!selected.length) {
      return res.status(400).json({ error: "Select at least one checklist item." });
    }

    let metadata = {};
    if (req.body.metadata) {
      try { metadata = JSON.parse(req.body.metadata); } catch (_) {}
    }

    const result = await runReview(req.files, selected, metadata);
    res.json({ ok: true, result });
  } catch (error) {
    console.error(error);
    const status = error?.code === "LIMIT_FILE_SIZE" ? 413 : 500;
    res.status(status).json({
      error: error?.message || "Credential packet review failed."
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Upload error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CredReview AI running on port ${PORT}`);
});
