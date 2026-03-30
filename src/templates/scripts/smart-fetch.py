#!/usr/bin/env python3
"""Smart web fetch with agentic web conventions.

Checks for llms.txt, requests text/markdown from Cloudflare sites,
and falls back to standard HTML fetching. Designed to minimize token
usage when agents need web content.

Ported from Dawn's infrastructure (Portal project). The key insight:
Cloudflare sites serve ~80% fewer tokens when you ask for text/markdown
via Accept header, and llms.txt provides machine-readable site maps.

Usage:
    python3 .instar/scripts/smart-fetch.py URL [--check-llms] [--markdown] [--raw] [--quiet]

Options:
    --check-llms   Check for /llms.txt and /llms-full.txt before fetching
    --markdown     Request text/markdown via Accept header (Cloudflare sites)
    --auto         Auto-detect: check llms.txt first, then try markdown, then HTML
    --raw          Output raw content only (no metadata headers)
    --quiet        Suppress status messages
    --max-tokens N Warn if estimated tokens exceed N (default: 50000)
"""

import argparse
import sys
import urllib.request
import urllib.error
import urllib.parse
from html.parser import HTMLParser


class SimpleHTMLToText(HTMLParser):
    """Minimal HTML to text converter for when markdown isn't available."""
    def __init__(self):
        super().__init__()
        self._text = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self._skip = False
        if tag in ('p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'):
            self._text.append('\n')

    def handle_data(self, data):
        if not self._skip:
            self._text.append(data)

    def get_text(self):
        return ''.join(self._text).strip()


def estimate_tokens(text):
    """Rough token estimate: ~4 chars per token for English."""
    return len(text) // 4


def fetch_url(url, accept_header=None, timeout=15):
    """Fetch a URL with optional Accept header."""
    headers = {
        'User-Agent': 'Instar-Agent/1.0 (Claude Code; agentic-web-fetch)'
    }
    if accept_header:
        headers['Accept'] = accept_header

    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        content_type = resp.headers.get('Content-Type', '')
        token_hint = resp.headers.get('X-Markdown-Tokens', '')
        body = resp.read().decode('utf-8', errors='replace')
        return {
            'status': resp.status,
            'content_type': content_type,
            'token_hint': token_hint,
            'body': body,
            'url': resp.url,
        }
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'error': str(e), 'body': ''}
    except Exception as e:
        return {'status': 0, 'error': str(e), 'body': ''}


def check_llms_txt(base_url):
    """Check for /llms.txt and /llms-full.txt at the site root."""
    parsed = urllib.parse.urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    results = {}

    for p in ['/llms.txt', '/llms-full.txt']:
        url = root + p
        result = fetch_url(url)
        if result['status'] == 200 and result['body'].strip():
            results[p] = {
                'url': url,
                'size': len(result['body']),
                'tokens': estimate_tokens(result['body']),
                'content': result['body']
            }

    return results


def smart_fetch(url, mode='auto', max_tokens=50000, raw=False, quiet=False):
    """Fetch content using the smartest available method."""
    log = lambda msg: None if quiet else print(msg, file=sys.stderr)

    # Step 1: Check llms.txt if in auto or check-llms mode
    if mode in ('auto', 'check-llms'):
        log(f"[smart-fetch] Checking for llms.txt at {url}...")
        llms = check_llms_txt(url)
        if llms:
            chosen = llms.get('/llms-full.txt', llms.get('/llms.txt'))
            found_path = '/llms-full.txt' if '/llms-full.txt' in llms else '/llms.txt'
            log(f"[smart-fetch] Found {found_path} ({chosen['tokens']} est. tokens)")

            if not raw:
                print(f"# Source: {chosen['url']}")
                print(f"# Method: llms.txt convention")
                print(f"# Estimated tokens: {chosen['tokens']}")
                print(f"# Available: {', '.join(llms.keys())}")
                print("---")
            print(chosen['content'])

            if chosen['tokens'] > max_tokens:
                log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
            return True
        else:
            log("[smart-fetch] No llms.txt found")

        if mode == 'check-llms':
            log("[smart-fetch] llms.txt check only - no content fetched")
            return False

    # Step 2: Try text/markdown (Cloudflare sites)
    if mode in ('auto', 'markdown'):
        log(f"[smart-fetch] Requesting text/markdown from {url}...")
        result = fetch_url(url, accept_header='text/markdown')

        if result['status'] == 200 and 'markdown' in result.get('content_type', ''):
            tokens = int(result['token_hint']) if result['token_hint'] else estimate_tokens(result['body'])
            log(f"[smart-fetch] Got markdown response ({tokens} est. tokens)")

            if not raw:
                print(f"# Source: {result['url']}")
                print(f"# Method: Cloudflare text/markdown")
                print(f"# Content-Type: {result['content_type']}")
                if result['token_hint']:
                    print(f"# X-Markdown-Tokens: {result['token_hint']}")
                print(f"# Estimated tokens: {tokens}")
                print("---")
            print(result['body'])

            if tokens > max_tokens:
                log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
            return True
        else:
            log("[smart-fetch] Markdown not available, falling back to HTML")

    # Step 3: Standard HTML fetch
    log(f"[smart-fetch] Fetching HTML from {url}...")
    result = fetch_url(url)

    if result['status'] == 200:
        parser = SimpleHTMLToText()
        parser.feed(result['body'])
        text = parser.get_text()
        tokens = estimate_tokens(text)
        log(f"[smart-fetch] Got HTML ({tokens} est. tokens after text extraction)")

        if not raw:
            print(f"# Source: {result['url']}")
            print(f"# Method: HTML (text extracted)")
            print(f"# Estimated tokens: {tokens}")
            print("---")
        print(text)

        if tokens > max_tokens:
            log(f"[smart-fetch] WARNING: Content exceeds {max_tokens} token limit")
        return True
    else:
        error = result.get('error', f"HTTP {result['status']}")
        log(f"[smart-fetch] Fetch failed: {error}")
        return False


def main():
    parser = argparse.ArgumentParser(description='Smart web fetch with agentic conventions')
    parser.add_argument('url', help='URL to fetch')
    parser.add_argument('--check-llms', action='store_true', help='Only check for llms.txt')
    parser.add_argument('--markdown', action='store_true', help='Request text/markdown only')
    parser.add_argument('--auto', action='store_true', help='Auto-detect best method (default)')
    parser.add_argument('--raw', action='store_true', help='Output raw content only')
    parser.add_argument('--quiet', action='store_true', help='Suppress status messages')
    parser.add_argument('--max-tokens', type=int, default=50000, help='Token warning threshold')
    args = parser.parse_args()

    if args.check_llms:
        mode = 'check-llms'
    elif args.markdown:
        mode = 'markdown'
    else:
        mode = 'auto'

    success = smart_fetch(args.url, mode=mode, max_tokens=args.max_tokens, raw=args.raw, quiet=args.quiet)
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
