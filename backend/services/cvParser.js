const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

/* ---- Content-based file type detection -------------------------------------
 *
 * The browser-supplied Content-Type cannot be trusted to identify the file,
 * and in practice it frequently does not: Android Chrome and iOS Safari both
 * report "application/octet-stream" (or nothing at all) for files chosen from
 * the Downloads folder, the Files app, or a cloud provider. Keying the parse
 * off that value made a perfectly valid PDF fail on a phone while working on a
 * developer's laptop.
 *
 * The bytes never lie, so the signature is checked first and the filename and
 * MIME are only fallbacks. DOCX is an OOXML package, which is a ZIP, so it
 * starts with the local-file-header magic "PK\x03\x04"; a legacy binary .doc
 * is an OLE2 compound file starting with D0 CF 11 E0 A1 B1 1A E1 and is
 * deliberately NOT supported, so it is recognised here purely so it can be
 * rejected with a clear message instead of a confusing ZIP error.
 */
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const RAR_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
const GIF_MAGIC = Buffer.from("GIF8", "latin1");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function startsWith(buffer, magic) {
  return buffer.length >= magic.length && buffer.slice(0, magic.length).equals(magic);
}

/** True when the bytes really are a PDF. */
function looksLikePdf(buffer) {
  return startsWith(buffer, PDF_MAGIC);
}

/** True when the bytes really are a ZIP/OOXML container, i.e. a DOCX. */
function looksLikeDocx(buffer) {
  if (!startsWith(buffer, ZIP_MAGIC)) return false;
  // A DOCX must contain a WordprocessingML document part. Checking for this
  // keeps arbitrary ZIPs (or a .doc renamed to .docx) from being handed to
  // mammoth and failing there with a library error.
  return buffer.includes(Buffer.from("word/document.xml", "latin1"));
}

/** Identifies a handful of other formats purely to give a precise 400. */
function describeOtherType(buffer) {
  if (startsWith(buffer, OLE2_MAGIC)) return "legacy Microsoft Word (.doc)";
  if (startsWith(buffer, PNG_MAGIC)) return "PNG image";
  if (startsWith(buffer, JPEG_MAGIC)) return "JPEG image";
  if (startsWith(buffer, GIF_MAGIC)) return "GIF image";
  if (startsWith(buffer, RAR_MAGIC)) return "RAR archive";
  return null;
}

/**
 * Resolves the real file type from the uploaded bytes.
 * @returns {"pdf"|"docx"} the detected type
 * @throws  Error (statusCode 400) when the content is neither PDF nor DOCX.
 */
function detectFileType(buffer, originalFilename, mimetype) {
  if (!buffer || buffer.length === 0) {
    const err = new Error("This file looks empty or damaged. Please check it and try again.");
    err.statusCode = 400;
    throw err;
  }

  if (looksLikePdf(buffer)) return "pdf";
  if (looksLikeDocx(buffer)) return "docx";

  const other = describeOtherType(buffer);
  if (other) {
    const err = new Error(
      `Unsupported file type: this is a ${other} file. Please upload a PDF or DOCX file.`
    );
    err.statusCode = 400;
    throw err;
  }

  // Unrecognised signature: trust the extension/MIME only to decide whether to
  // try a parse. These are genuine document containers whose magic may sit
  // behind a preamble (some PDFs begin with whitespace or a BOM before %PDF-).
  const ext = String(originalFilename || "").split(".").pop().toLowerCase();
  const mime = String(mimetype || "").toLowerCase();
  const pdfish = ext === "pdf" || mime.includes("pdf");
  const docxish = ext === "docx" || mime.includes("wordprocessingml");

  if (pdfish || docxish) {
    return pdfish && !docxish ? "pdf" : "docx";
  }

  const err = new Error("Please upload your CV as a PDF or DOCX file.");
  err.statusCode = 400;
  throw err;
}

async function parseCV(buffer, fileType, originalFilename) {
  if (!buffer || buffer.length === 0) {
    const err = new Error("This file looks empty or damaged. Please check it and try again.");
    err.statusCode = 400;
    throw err;
  }

  let text = "";

  try {
    if (fileType === "pdf") {
       // pdf.js reads the underlying ArrayBuffer; Node Buffers are pooled and have byteOffset != 0,
       // so passing Buffer directly causes bad XRef/Invalid number errors in Node 24.
       // Use a copied Uint8Array to give pdf-parse a clean, correctly-sized view.
       const pdfData = Buffer.isBuffer(buffer) ? Uint8Array.from(buffer) : buffer;
       const data = await pdfParse(pdfData);
      text = (data.text || "").trim();
      if (!text || text.length < 20) {
        const err = new Error(
          "We couldn't find any text in this PDF — it may be a scanned image. Please upload a PDF you can select text from, or a DOCX file."
        );
        err.statusCode = 422;
        throw err;
      }
    } else if (fileType === "docx") {
      const result = await mammoth.extractRawText({ buffer });
      text = (result.value || "").trim();
      if (!text || text.length < 20) {
        const err = new Error("We couldn't find any text in this document. Please check the file and try again.");
        err.statusCode = 422;
        throw err;
      }
    } else {
      const err = new Error("Please upload your CV as a PDF or DOCX file.");
      err.statusCode = 400;
      throw err;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    // The underlying libraries (pdf.js, JSZip) throw messages that are useless
    // to a user and can echo internals back to the browser, so replace them
    // with a single clear, actionable sentence.
    console.warn(`[cvParser] parse failed for type=${fileType} size=${buffer?.length}: ${e.message}`);
    const err = new Error(
      fileType === "pdf"
      ? "We couldn't read this PDF. It may be damaged or password-protected — please save a new copy and try again."
      : "We couldn't read this document. It may be damaged — please save a new copy and try again."
    );
    err.statusCode = 422;
    throw err;
  }

  // Clean text: normalize whitespace, remove excessive blank lines
  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Limit to prevent token explosion
  if (text.length > 30000) text = text.slice(0, 30000);

  return text;
}

module.exports = { parseCV, detectFileType, looksLikePdf, looksLikeDocx };
