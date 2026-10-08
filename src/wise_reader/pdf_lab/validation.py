"""Validate originals in a short-lived parser process, without loading OCR models."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


def validate(path: Path) -> dict:
    try:
        if importlib.util.find_spec("pymupdf"):
            import pymupdf
            with pymupdf.open(path) as document:
                if not document.is_pdf:
                    raise ValueError("The file is not a PDF.")
                if document.needs_pass:
                    return {"error": "access_restricted", "message": "PDF requires a password."}
                count = document.page_count
                if count:
                    document.load_page(0)
                    document.load_page(count - 1)
                return {"page_count": count, "validator": "pymupdf"}
        if importlib.util.find_spec("pypdf"):
            from pypdf import PdfReader
            reader = PdfReader(path, strict=True)
            if reader.is_encrypted and not reader.decrypt(""):
                return {"error": "access_restricted", "message": "PDF requires a password."}
            return {"page_count": len(reader.pages), "validator": "pypdf"}
        if importlib.util.find_spec("pypdfium2"):
            import pypdfium2
            with pypdfium2.PdfDocument(str(path)) as document:
                count = len(document)
                if count:
                    for index in {0, count - 1}:
                        page = document[index]
                        try:
                            page.get_size()
                        finally:
                            page.close()
                return {"page_count": count, "validator": "pdfium"}
        if sys.platform == "darwin" and Path("/usr/bin/swift").is_file():
            code = r'''
import Foundation
import PDFKit
let url = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PDF_LAB_SOURCE"]!)
if let pdf = PDFDocument(url: url) {
    if pdf.isLocked {
        print("{\"error\":\"access_restricted\",\"message\":\"PDF requires a password.\"}")
    } else {
        print("{\"page_count\":\(pdf.pageCount),\"validator\":\"PDFKit\"}")
    }
} else {
    print("{\"error\":\"format_unreadable\",\"message\":\"PDF parser could not open the file.\"}")
}
'''
            environment = dict(os.environ, PDF_LAB_SOURCE=str(path))
            process = subprocess.run(["/usr/bin/swift", "-e", code], env=environment,
                                     capture_output=True, text=True, timeout=20)
            if process.returncode == 0:
                return json.loads(process.stdout.strip().splitlines()[-1])
            return {"error": "validator_unavailable", "message": "Native PDF validator failed."}
        return {"error": "validator_unavailable", "message": "No local PDF parser is installed."}
    except (ValueError, RuntimeError, OSError, IndexError) as exc:
        restricted = "password" in str(exc).lower() or "encrypt" in str(exc).lower()
        return {"error": "access_restricted" if restricted else "format_unreadable",
                "message": "PDF requires a password." if restricted else str(exc)[:300]}
    except subprocess.TimeoutExpired:
        return {"error": "validator_timeout", "message": "Local PDF validation timed out."}
    except Exception as exc:
        restricted = "password" in str(exc).lower() or "encrypt" in str(exc).lower()
        return {"error": "access_restricted" if restricted else "format_unreadable",
                "message": "PDF requires a password." if restricted else "Local PDF parser could not open the file."}


if __name__ == "__main__":
    print(json.dumps(validate(Path(sys.argv[1])), ensure_ascii=False))
