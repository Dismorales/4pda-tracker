"""Optional runner: uses an already installed Playwright and Chrome, no app dependencies."""
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page()
    page.goto((Path(__file__).parent / "run.html").resolve().as_uri())
    page.wait_for_function("document.querySelector('#results').textContent.includes('DONE:')", timeout=30000)
    result = page.locator("#results").inner_text()
    print(result)
    browser.close()
    if "FAIL " in result:
        raise SystemExit(1)
