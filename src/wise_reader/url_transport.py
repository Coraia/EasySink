"""Bounded URL transport using system networking without browser credentials."""
from __future__ import annotations

from dataclasses import dataclass
import http.client
import io
import ipaddress
import re
import socket
import ssl
import sys
import threading
import time
from urllib.request import getproxies, proxy_bypass
from urllib.parse import urljoin, urlsplit, urlunsplit

if sys.platform == 'darwin':
    from urllib.request import getproxies_macosx_sysconf as getproxies
    from urllib.request import proxy_bypass_macosx_sysconf as proxy_bypass

HTML_LIMIT = 5 * 1024 * 1024
RESOURCE_LIMIT = 20 * 1024 * 1024
LINE_LIMIT = 8192
HEADER_LIMIT = 65536
HEADER_COUNT = 100


class ImportFailure(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True)
class Target:
    url: str
    host: str
    port: int
    secure: bool
    request_target: str
    authority: str


@dataclass(frozen=True)
class Fetched:
    original_url: str
    final_url: str
    body: bytes
    mime: str
    headers: tuple[tuple[str, str], ...]


class Control:
    def __init__(self):
        self.deadline = time.monotonic() + 30
        self.cancelled = threading.Event()
        self.total_bytes = 0
        self._socket = None
        self._lock = threading.Lock()

    def remaining(self, until: float | None = None) -> float:
        if self.cancelled.is_set():
            raise ImportFailure("cancelled")
        remaining = min(self.deadline, until or self.deadline) - time.monotonic()
        if remaining <= 0:
            raise ImportFailure("timeout")
        return remaining

    def bind(self, sock):
        with self._lock:
            self.remaining()
            self._socket = sock

    def unbind(self):
        with self._lock:
            self._socket = None

    def cancel(self):
        self.cancelled.set()
        with self._lock:
            sock = self._socket
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()

    def consume(self, count: int):
        self.remaining()
        self.total_bytes += count
        if self.total_bytes > RESOURCE_LIMIT:
            raise ImportFailure("resource_limit")


def normalize_url(value: str) -> Target:
    if (not isinstance(value, str) or len(value) > 4096 or not value
            or any(ord(ch) <= 32 or ord(ch) == 127 for ch in value) or "\\" in value):
        raise ImportFailure("invalid_url")
    try:
        parts = urlsplit(value)
        scheme = parts.scheme.lower()
        if scheme not in {"http", "https"} or not parts.netloc or parts.username is not None or parts.password is not None:
            raise ValueError("scheme or credentials")
        host = parts.hostname
        if not host or "%" in parts.netloc or "@" in parts.netloc:
            raise ValueError("host")
        secure = scheme == "https"
        port = parts.port if parts.port is not None else (443 if secure else 80)
        if port not in {80, 443} or parts.netloc.endswith(":"):
            raise ValueError("port")
        host = host.encode("idna").decode("ascii").lower()
        if host.endswith(".") or len(host) > 253:
            raise ValueError("host ambiguity")
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            host = str(literal)
        else:
            labels = host.rstrip('.').split('.')
            if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
                raise ValueError("host syntax")
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if secure else 80):
            authority += f":{port}"
        path = parts.path or "/"
        request_target = path + ("?" + parts.query if parts.query else "")
        request_target.encode("ascii")
        return Target(urlunsplit((scheme, authority, path, parts.query, "")), host, port, secure, request_target, authority)
    except (ValueError, UnicodeError) as exc:
        raise ImportFailure("invalid_url") from exc


class _DeadlineRaw(io.RawIOBase):
    def __init__(self, sock, control):
        super().__init__()
        self.sock = sock
        self.control = control

    def readable(self):
        return True

    def readinto(self, buffer):
        # Closing a descriptor in another thread need not wake macOS's timed
        # socket wait. Poll the cancellation token without resetting its deadline.
        while True:
            self.sock.settimeout(min(0.1, self.control.remaining()))
            try:
                return self.sock.recv_into(buffer, len(buffer))
            except TimeoutError:
                self.control.remaining()


class _BoundedReader:
    def __init__(self, sock, control):
        self.reader = io.BufferedReader(_DeadlineRaw(sock, control), buffer_size=8192)
        self.header_bytes = 0
        self.header_lines = 0
        self.in_headers = True

    def readline(self, limit=-1):
        line = self.reader.readline(min(limit, LINE_LIMIT + 1) if limit >= 0 else LINE_LIMIT + 1)
        if len(line) > LINE_LIMIT:
            raise ImportFailure("header_limit")
        self.header_bytes += len(line)
        if self.header_bytes > HEADER_LIMIT:
            raise ImportFailure("header_limit")
        if self.in_headers:
            self.header_lines += 1
            if self.header_lines > HEADER_COUNT:
                raise ImportFailure("header_limit")
            if line in (b"\r\n", b"\n", b""):
                self.in_headers = False
        return line

    def read(self, count=-1):
        if count < 0:
            raise ImportFailure("unbounded_read")
        return self.reader.read(count)

    def readinto(self, buffer):
        return self.reader.readinto(buffer)

    def flush(self):
        return self.reader.flush()

    def close(self):
        self.reader.close()


class _Response(http.client.HTTPResponse):
    def _read_status(self):
        # Informational responses share one header budget, not a new allowance.
        self.fp.in_headers = True
        version, status, reason = super()._read_status()
        if status < 200:
            raise ImportFailure("unsupported_status")
        return version, status, reason


class _SocketView:
    def __init__(self, sock, control):
        self.sock, self.control = sock, control

    def makefile(self, mode):
        return _BoundedReader(self.sock, self.control)

    def sendall(self, data):
        self.sock.settimeout(self.control.remaining())
        self.sock.sendall(data)

    def close(self):
        # HTTPConnection may close its view before a close-delimited body is read.
        # The hop owns and closes the physical socket in its unconditional finally.
        pass


def _hop(target: Target, kind: str, control: Control):
    hop_deadline = min(control.deadline, time.monotonic() + 10)
    scheme = "https" if target.secure else "http"
    proxy = getproxies().get(scheme) if not proxy_bypass(target.host) else None
    host, port = target.host, target.port
    if proxy:
        parsed = urlsplit(proxy if "://" in proxy else "http://" + proxy)
        if parsed.scheme != "http" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ImportFailure("unsupported_proxy")
        host, port = parsed.hostname, parsed.port or 80
    connection_type = http.client.HTTPSConnection if target.secure else http.client.HTTPConnection
    connection = connection_type(host, port, timeout=control.remaining(hop_deadline))
    if proxy and target.secure:
        connection.set_tunnel(target.host, target.port)
    sock = None
    response = None
    try:
        connection.connect()
        sock = connection.sock
        control.bind(sock)
        control.remaining(hop_deadline)
        connection.response_class = _Response
        connection.sock = _SocketView(sock, control)
        request_target = target.url if proxy and not target.secure else target.request_target
        connection.putrequest("GET", request_target, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", target.authority)
        connection.putheader("Accept-Encoding", "identity")
        connection.putheader("Accept", "text/html" if kind == "html" else "image/png,image/jpeg,image/webp")
        connection.putheader("Connection", "close")
        connection.endheaders()
        response = connection.getresponse()
        headers = tuple(response.getheaders())
        lengths = response.headers.get_all("Content-Length", [])
        encodings = response.headers.get_all("Transfer-Encoding", [])
        if (len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings)
                or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0]))
                or (encodings and encodings[0].lower() != "chunked")):
            raise ImportFailure("invalid_framing")
        if response.status in {301, 302, 303, 307, 308}:
            locations = response.headers.get_all("Location", [])
            if len(locations) != 1 or not locations[0]:
                raise ImportFailure("invalid_redirect")
            return None, locations[0]
        if response.status != 200:
            raise ImportFailure("http_status", f"HTTP {response.status}")
        content_encodings = response.headers.get_all("Content-Encoding", [])
        if content_encodings and content_encodings != ["identity"]:
            raise ImportFailure("unsupported_encoding")
        types = response.headers.get_all("Content-Type", [])
        if len(types) != 1 or (kind == "html" and response.headers.get("Content-Disposition", "").lower().startswith("attachment")):
            raise ImportFailure("unsupported_content")
        mime = types[0].split(";", 1)[0].strip().lower()
        allowed = {"text/html", "application/xhtml+xml"} if kind == "html" else {"image/png", "image/jpeg", "image/webp"}
        if mime not in allowed:
            raise ImportFailure("unsupported_content")
        if lengths and int(lengths[0]) > HTML_LIMIT:
            raise ImportFailure("size_limit")
        body = bytearray()
        while True:
            control.remaining()
            chunk = response.read(min(16384, HTML_LIMIT - len(body) + 1))
            if not chunk:
                break
            control.consume(len(chunk))
            body.extend(chunk)
            if len(body) > HTML_LIMIT:
                raise ImportFailure("size_limit")
        if lengths and len(body) != int(lengths[0]):
            raise ImportFailure("truncated_response")
        return Fetched(target.url, target.url, bytes(body), mime, headers), None
    finally:
        try:
            if response is not None:
                response.close()
        finally:
            try:
                if connection is not None:
                    connection.close()
            finally:
                try:
                    if sock is not None:
                        sock.close()
                finally:
                    control.unbind()


def fetch(url: str, kind: str, control: Control, *, secure_parent: bool = False) -> Fetched:
    original = url
    current = normalize_url(url)
    seen = set()
    try:
        for hop in range(4):
            control.remaining()
            if current.url in seen:
                raise ImportFailure("redirect_loop")
            if secure_parent and not current.secure:
                raise ImportFailure("https_downgrade")
            seen.add(current.url)
            result, location = _hop(current, kind, control)
            if result is not None:
                return Fetched(original, result.final_url, result.body, result.mime, result.headers)
            if hop == 3:
                raise ImportFailure("redirect_limit")
            following = normalize_url(urljoin(current.url, location))
            if current.secure and not following.secure:
                raise ImportFailure("https_downgrade")
            current = following
    except ssl.SSLCertVerificationError as exc:
        raise ImportFailure("tls_verification") from exc
    except (OSError, http.client.HTTPException) as exc:
        control.remaining()
        raise ImportFailure("network_failed") from exc
    raise ImportFailure("redirect_limit")
