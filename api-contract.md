# API contract

POST `/api/review`

Multipart form:
- `packet`: one or more PDF/image files
- `checklist`: JSON array of checklist names
- `metadata`: JSON object. Reserved for future case metadata such as `caseStartDate` and `packetCreatedDate`.

Response:
```json
{
  "ok": true,
  "result": {
    "packet_type": "CREDENTIALING_PACKET",
    "overall_status": "WARN",
    "findings": []
  }
}
```
