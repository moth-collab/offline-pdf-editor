"""Digital signatures (pyHanko) and saved electronic signatures.

* Create a self-signed Digital ID (PKCS#12, RSA 2048, SHA-256).
* Sign PDFs (PAdES baseline, SHA-256) with a visible or invisible signature.
* Validate signatures offline: integrity, cryptographic validity, coverage,
  modifications after signing, certificate details. No revocation servers are
  contacted (offline application); trust is reported accordingly.
"""
from __future__ import annotations

import base64
import datetime as dt
import logging
import hashlib
import io
import json
import os
import uuid
from pathlib import Path

from core.config import get_settings
from core.errors import AppError

# expected validation outcomes (e.g. self-signed certificates) are reported to
# the user; pyHanko's tracebacks for them are noise
for _name in ("pyhanko", "pyhanko_certvalidator"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)


# ----------------------------------------------------------------------
# Digital ID
# ----------------------------------------------------------------------

def create_digital_id(target: Path, name: str, email: str, organization: str, country: str, password: str,
                      years: int = 5) -> dict:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    if not name.strip():
        raise AppError("invalid_request", "Enter your name")
    if len(password) < 6:
        raise AppError("invalid_request", "Use a password of at least 6 characters to protect the Digital ID")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, name.strip()[:64])]
    if organization.strip():
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization.strip()[:64]))
    if country.strip():
        if len(country.strip()) != 2:
            raise AppError("invalid_request", "The country must be a 2-letter code (e.g. TH)")
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, country.strip().upper()))
    if email.strip():
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, email.strip()[:128]))
    subject = x509.Name(attrs)
    now = dt.datetime.now(dt.timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=365 * years))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                     data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                     crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION, ExtendedKeyUsageOID.CODE_SIGNING]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    if email.strip():
        builder = builder.add_extension(x509.SubjectAlternativeName([x509.RFC822Name(email.strip())]), critical=False)
    cert = builder.sign(key, hashes.SHA256())
    data = pkcs12.serialize_key_and_certificates(name.encode("utf-8")[:64], key, cert, None,
                                                 serialization.BestAvailableEncryption(password.encode("utf-8")))
    tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.part")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return {"path": str(target), "subject": name, "fingerprint": hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()}


def _load_signer(pfx: Path, password: str):
    from pyhanko.sign import signers

    try:
        signer = signers.SimpleSigner.load_pkcs12(pfx_file=str(pfx), passphrase=password.encode("utf-8"))
    except Exception as exc:  # wrong password or invalid file
        raise AppError("invalid_digital_id", f"The Digital ID could not be opened: {exc.__class__.__name__}") from exc
    if signer is None:
        raise AppError("invalid_digital_id", "The Digital ID could not be opened (wrong password?)")
    return signer


def sign_pdf(src: Path, target: Path, pfx: Path, password: str, *, page: int = 0, rect: list[float] | None = None,
             reason: str = "", location: str = "", contact: str = "", field_name: str | None = None) -> dict:
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.stamp import TextStampStyle

    signer = _load_signer(pfx, password)
    name = field_name or f"Signature{uuid.uuid4().hex[:6]}"
    tmp = target.with_name(f".{target.stem}.{uuid.uuid4().hex[:6]}.signing.pdf")
    try:
        with open(src, "rb") as inf:
            w = IncrementalPdfFileWriter(inf, strict=False)
            existing_empty = False
            if field_name:
                for fname, value, _ref in fields.enumerate_sig_fields(w, filled_status=None):
                    if fname == field_name:
                        if value is not None:
                            raise AppError("already_signed", "This signature field is already signed")
                        existing_empty = True
            if existing_empty:
                pass  # sign into the empty signature field placed in the form
            elif rect:
                fields.append_signature_field(w, fields.SigFieldSpec(sig_field_name=name, on_page=page,
                                                                     box=tuple(float(v) for v in rect)))
            else:
                fields.append_signature_field(w, fields.SigFieldSpec(sig_field_name=name, on_page=page))
            meta = signers.PdfSignatureMetadata(field_name=name, reason=reason or None, location=location or None,
                                                contact_info=contact or None, md_algorithm="sha256",
                                                subfilter=fields.SigSeedSubFilter.PADES)
            style = TextStampStyle(stamp_text="Digitally signed by %(signer)s\nDate: %(ts)s" +
                                   ("\nReason: %(reason)s" if reason else ""))
            pdf_signer = signers.PdfSigner(meta, signer=signer, stamp_style=style)
            with open(tmp, "wb") as outf:
                pdf_signer.sign_pdf(w, output=outf, appearance_text_params={"reason": reason} if reason else None)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return {"path": str(target), "field": name}


def validate(path: Path) -> list[dict]:
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    out = []
    with open(path, "rb") as f:
        try:
            r = PdfFileReader(f, strict=False)
        except Exception as exc:
            raise AppError("unreadable", f"The document structure cannot be read for validation: {exc}") from exc
        if r.encrypted:
            return [{"error": "Encrypted documents must be decrypted to validate signatures"}]
        for sig in r.embedded_signatures:
            item: dict = {"field": sig.field_name}
            try:
                vc = ValidationContext(allow_fetching=False)
                st = validate_pdf_signature(sig, vc)
                cert = st.signing_cert
                item.update({
                    "intact": bool(st.intact),
                    "valid": bool(st.valid),
                    "trusted": bool(st.trusted),
                    "coverage": str(getattr(st, "coverage", "")).split(".")[-1],
                    "modification_level": str(getattr(st, "modification_level", "")).split(".")[-1],
                    "docmdp_ok": getattr(st, "docmdp_ok", None),
                    "signing_time": st.signer_reported_dt.isoformat() if st.signer_reported_dt else None,
                    "md_algorithm": getattr(st, "md_algorithm", None),
                    "summary": st.summary(),
                    "signer": cert.subject.human_friendly if cert else None,
                    "issuer": cert.issuer.human_friendly if cert else None,
                    "serial": format(cert.serial_number, "x") if cert else None,
                    "not_before": cert["tbs_certificate"]["validity"]["not_before"].native.isoformat() if cert else None,
                    "not_after": cert["tbs_certificate"]["validity"]["not_after"].native.isoformat() if cert else None,
                    "self_signed": bool(cert and cert.self_signed in ("yes", "maybe")),
                })
            except Exception as exc:
                item.update({"intact": False, "valid": False, "trusted": False, "error": str(exc)})
            out.append(item)
    return out


# ----------------------------------------------------------------------
# saved electronic signatures (images, stored locally)
# ----------------------------------------------------------------------

def _index_path() -> Path:
    return get_settings().sessions_root.parent / "signatures.json"


def list_saved() -> list[dict]:
    try:
        return json.loads(_index_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_signature(data_base64: str, kind: str) -> dict:
    from PIL import Image

    from services.overlay_editor import assets_dir

    raw = base64.b64decode(data_base64.split(",")[-1])
    if len(raw) > 10 * 1024 * 1024:
        raise AppError("too_large", "The signature image is too large")
    im = Image.open(io.BytesIO(raw))
    im.load()
    buf = io.BytesIO()
    im.convert("RGBA").save(buf, "PNG")
    data = buf.getvalue()
    asset_id = f"{hashlib.sha256(data).hexdigest()[:40]}.png"
    d = assets_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / asset_id).write_bytes(data)
    items = [x for x in list_saved() if x["asset_id"] != asset_id]
    entry = {"id": uuid.uuid4().hex, "asset_id": asset_id, "kind": kind if kind in ("drawn", "typed", "image", "initials") else "image",
             "width": im.width, "height": im.height, "created": dt.datetime.now().isoformat(timespec="seconds")}
    items.insert(0, entry)
    _index_path().write_text(json.dumps(items[:20]), encoding="utf-8")
    return entry


def delete_saved(sig_id: str) -> None:
    items = [x for x in list_saved() if x["id"] != sig_id]
    _index_path().write_text(json.dumps(items), encoding="utf-8")
