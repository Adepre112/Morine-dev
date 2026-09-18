const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

async function parseCV(buffer, fileType, originalFilename) {
  if (!buffer || buffer.length === 0) {
    const err = new Error("File is empty or corrupted.");
    err.statusCode = 400;
    throw err;
  }

  let text = "";

  console.log(`[cvParser] parsing ${originalFilename} type=${fileType} size=${buffer?.length} head=${buffer?.slice(0,20).toString()}`);
  try {
    if (fileType === "pdf") {
       // pdf.js reads the underlying ArrayBuffer; Node Buffers are pooled and have byteOffset != 0,
       // so passing Buffer directly causes bad XRef/Invalid number errors in Node 24.
       // Use a copied Uint8Array to give pdf-parse a clean, correctly-sized view.
       const pdfData = Buffer.isBuffer(buffer) ? Uint8Array.from(buffer) : buffer;
       const data = await pdfParse(pdfData);
      console.log(`[cvParser] pdfParse ok textLen=${(data.text||'').length}`);
      text = (data.text || "").trim();
      if (!text || text.length < 20) {
        const err = new Error(
          "This PDF appears to be scanned/image-only or contains no extractable text. Please upload a text-based PDF or DOCX. OCR for scanned PDFs is not yet supported."
        );
        err.statusCode = 422;
        throw err;
      }
    } else if (fileType === "docx") {
      const result = await mammoth.extractRawText({ buffer });
      text = (result.value || "").trim();
      if (!text || text.length < 20) {
        const err = new Error("DOCX contains no readable text or appears empty.");
        err.statusCode = 422;
        throw err;
      }
    } else {
      const err = new Error("Unsupported file type. Only PDF and DOCX are allowed.");
      err.statusCode = 400;
      throw err;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    const err = new Error(`Failed to parse ${originalFilename}: ${e.message}`);
    err.statusCode = 422;
    throw err;
  }

  // Clean text: normalize whitespace, remove excessive blank lines
  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Limit to prevent token explosion
  if (text.length > 30000) text = text.slice(0, 30000);

  return text;
}

module.exports = { parseCV };
