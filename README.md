# CredReview AI — complete Replit prototype

This is a full-stack credentialing-packet review prototype.

## What it does

1. Accepts multiple PDF/image documents.
2. Sends them to a secure Node/Express backend.
3. The backend uploads the documents to OpenAI using the Files API.
4. The Responses API receives the files and returns a strict JSON review.
5. The LLM first classifies whether the upload is actually a credentialing packet.
6. If the upload is an academic/unrelated document (for example a B.Tech results PDF), the review is blocked instead of returning fake PASS results.
7. If it is a credentialing packet, the backend reviews the selected checklist:
   - CAQH
   - NPI
   - LICENSE
   - BOARDCERT
   - PLI
   - WORK HISTORY
   - NPDB
   - DOCUMENTS
   - PROVIDER TYPE
   - ALIAS NAMES
   - START DATE
   - COMPLETION DATE
8. Alias Names is explicitly cross-document: CAQH, NPI, licenses, documents and BoardCert.
9. Start Date means case initiation date. Completion Date means packet-created/completion date. The AI will not substitute today's date.
10. Every PASS is required to have evidence from the supplied files. Missing/unreadable evidence becomes NEEDS_DATA.
11. Uploaded OpenAI file objects are deleted by the backend after the review response is received.

## Run in Replit

1. Upload this folder/ZIP to a new Replit Node.js app.
2. Add a secret named `OPENAI_API_KEY`.
3. Optional: add `OPENAI_MODEL`. Default is `gpt-6-luna`.
4. Run `npm install`.
5. Run `npm start`.
6. Open the web app.

## Important

This is an engineering prototype, not a production credentialing compliance system. Do not treat the LLM as external verification. For production, add authentication, encrypted storage, audit logs, access controls, retention/deletion policies, human-review workflows, organization-specific credentialing rules, and explicit integration with any authoritative external sources you are permitted to use.

The OpenAI API key must stay on the server and must never be placed in `public/index.html`.
