"""Small, explicit source rules for public-article imports."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from .url_transport import normalize_url


@dataclass(frozen=True)
class SourceRule:
    id: str
    host: str
    path_prefixes: tuple[str, ...] = ()

    def matches(self, host: str, path: str) -> bool:
        return host == self.host and (
            not self.path_prefixes or any(path.startswith(prefix) for prefix in self.path_prefixes)
        )


# These rules only decide whether Wise Reader may try a public page without an
# extra confirmation. They do not assert that every matching page is readable,
# accurate, peer reviewed, or covered by a particular licence.
BUILTIN_SOURCE_RULES = (
    SourceRule("anthropic-research", "www.anthropic.com", ("/research/",)),
    SourceRule("google-research", "research.google", ("/blog/",)),
    SourceRule("openai-index", "openai.com", ("/index/",)),
    SourceRule("microsoft-research", "www.microsoft.com", ("/en-us/research/blog/",)),
    SourceRule("apple-machine-learning", "machinelearning.apple.com"),
    SourceRule("meta-ai-blog", "ai.meta.com", ("/blog/",)),
    SourceRule("cloudflare-blog", "blog.cloudflare.com"),
    SourceRule("github-blog", "github.blog"),
    SourceRule("pubmed-central", "pmc.ncbi.nlm.nih.gov", ("/articles/PMC",)),
    SourceRule("plos-journals", "journals.plos.org", ("/plos",)),
    SourceRule("elife-articles", "elifesciences.org", ("/articles/",)),
    SourceRule("arxiv-html", "arxiv.org", ("/html/",)),
    SourceRule("rfc-editor", "www.rfc-editor.org", ("/rfc/",)),
    SourceRule("w3c-technical-reports", "www.w3.org", ("/TR/",)),
    SourceRule("martin-fowler-articles", "martinfowler.com", ("/articles/",)),
    SourceRule("julia-evans", "jvns.ca"),
    SourceRule("simon-willison", "simonwillison.net"),
)


def source_policy(value: str) -> dict:
    target = normalize_url(value)
    path = urlsplit(target.url).path or "/"
    rule = next((item for item in BUILTIN_SOURCE_RULES if item.matches(target.host, path)), None)
    return {
        "url": target.url,
        "host": target.host,
        "builtin": rule is not None,
        "rule": rule.id if rule else None,
    }
