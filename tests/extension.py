"""MV3 integration with a temporary Chromium profile and intercepted forum fixtures."""
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
topic_url = "https://4pda.to/forum/index.php?showtopic=1109483"
pages = {0: ["10", "11"], 2: ["12", "10", "13"]}
fail_offset = None
forum_title = ["First real topic"]


def forum(route):
    offset = int(parse_qs(urlparse(route.request.url).query).get("st", ["0"])[0])
    if offset == fail_offset:
        route.fulfill(status=503, content_type="text/html", body="Temporary failure")
        return
    links = "".join(f'<a href="{topic_url}&st={st}">{st // 2 + 1}</a>' for st in pages)
    posts = "".join(
        f'<table class="ipbtable"><tr><td class="normalname">author{id}</td>'
        f'<td class="postdetails">Сегодня, 13:31</td></tr><tr><td id="post-main-{id}">'
        f'<div id="post-{id}" class="postcolor">Text {id}</div></td></tr></table>'
        for id in pages[offset])
    route.fulfill(content_type="text/html; charset=utf-8", body=
        f"<title>{forum_title[0]} - 4PDA</title><h1>[X]Помощник</h1>{links}{posts}{links}")


with tempfile.TemporaryDirectory(prefix="4pda-extension-test-", ignore_cleanup_errors=True) as profile, sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        profile, channel="chromium", headless=True,
        args=[f"--disable-extensions-except={root}", f"--load-extension={root}"])
    context.route("https://4pda.to/**", forum)
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
    extension_id = worker.url.split("/")[2]
    ui = context.new_page()
    ui.goto(f"chrome-extension://{extension_id}/options.html")

    def start(command):
        result = ui.evaluate("""([command, url]) => chrome.runtime.sendMessage({type: 'start', command, url})""", [command, topic_url])
        assert result.get("ok"), result

    def completed():
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # Pump Playwright events so intercepted tab navigation gets fulfilled.
            ui.wait_for_timeout(100)
            job = worker.evaluate("chrome.storage.session.get('job').then(x => x.job)")
            if job and job["state"] != "running":
                ui.wait_for_timeout(100)
                return job
        raise AssertionError("Job timed out")

    start("add")
    assert completed()["state"] == "done"
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.lastPostId)") == "13"
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.title)") == "First real topic"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    print("PASS MV3 add from extension page: latest baseline, no history import")

    forum_title[0] = "Updated real topic"
    start("check")
    assert completed()["state"] == "done"
    saved = worker.evaluate("dbGet('topics', '1109483')")
    assert saved["title"] == "Updated real topic" and saved["lastPostId"] == "13", saved
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    print("PASS MV3 successful check refreshes title without marker or history changes")

    pages[4] = ["14", "10", "15"]
    pages[6] = ["16", "17", "10"]
    fail_offset = 4
    start("check")
    assert completed()["state"] == "error"
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.lastPostId)") == "13"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    print("PASS MV3 failed page: no batch or marker advancement")

    fail_offset = None
    # Pre-existing rows from older interrupted implementations must not be skipped.
    worker.evaluate("dbPut('posts', {postId: '14', topicId: '1109483', text: 'old partial'})")
    start("check")
    # Close initiating UI; work is owned by the service worker.
    ui.close()
    ui = context.new_page()
    ui.goto(f"chrome-extension://{extension_id}/options.html")
    assert completed()["state"] == "done"
    batches = worker.evaluate("dbGetAll('batches')")
    assert len(batches) == 1 and batches[0]["postIds"] == ["14", "15", "16", "17"], batches
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.lastPostId)") == "17"
    ui.locator("[data-downloadbatch]").wait_for()
    with ui.expect_download() as info:
        ui.locator("[data-downloadbatch]").click()
    markdown = Path(info.value.path()).read_text(encoding="utf-8")
    assert "## Пост #10\n" not in markdown and "**Время:** Сегодня, 13:31" in markdown
    print("PASS MV3 retry after UI closure: complete batch, no pinned header, Markdown download")

    start("check")
    assert completed()["state"] == "done"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 1
    start("reset")
    assert completed()["state"] == "done"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 1
    print("PASS MV3 repeat and reset preserve history without duplicate batches")
    context.close()
