"""MV3 integration with a temporary Chromium profile and intercepted forum fixtures."""
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
topic_url = "https://4pda.to/forum/index.php?showtopic=1109483"
pages = {0: ["10", "11"], 2: ["10", "12", "13"]}
topic_pages = {
    "1109483": pages,
    "200": {0: ["2000"]},
    "300": {0: ["3000"]},
}
fail_page = [None]
forum_titles = {
    "1109483": "First real topic",
    "200": "Zulu legacy topic",
    "300": "Alpha legacy topic",
}


def forum(route):
    query = parse_qs(urlparse(route.request.url).query)
    topic_id = query["showtopic"][0]
    offset = int(query.get("st", ["0"])[0])
    if fail_page[0] == (topic_id, offset):
        route.fulfill(status=503, content_type="text/html", body="Temporary failure")
        return
    current_pages = topic_pages[topic_id]
    current_url = f"https://4pda.to/forum/index.php?showtopic={topic_id}"
    links = "".join(f'<a href="{current_url}&st={st}">{st // 2 + 1}</a>' for st in current_pages)
    posts = "".join(
        f'<table class="ipbtable"><tr><td class="normalname">author{id}</td>'
        f'<td class="postdetails">Сегодня, 13:31</td></tr><tr><td id="post-main-{id}">'
        f'<div id="post-{id}" class="postcolor">Text {id}</div></td></tr></table>'
        for id in current_pages[offset])
    route.fulfill(content_type="text/html; charset=utf-8", body=
        f"<title>{forum_titles[topic_id]} - 4PDA</title><h1>[X]Помощник</h1>{links}{posts}{links}")


with tempfile.TemporaryDirectory(prefix="4pda-extension-test-", ignore_cleanup_errors=True) as profile, sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        profile, channel="chromium", headless=True,
        args=[f"--disable-extensions-except={root}", f"--load-extension={root}"])
    context.route("https://4pda.to/**", forum)
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
    extension_id = worker.url.split("/")[2]
    ui = context.new_page()
    ui.goto(f"chrome-extension://{extension_id}/options.html")

    def start(command, url=topic_url):
        result = ui.evaluate("""([command, url]) => chrome.runtime.sendMessage({type: 'start', command, url})""", [command, url])
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

    worker.evaluate("""Promise.all([
      dbPut('topics', {topicId: '200', title: 'Zulu legacy topic', url: 'https://4pda.to/forum/index.php?showtopic=200', lastPostId: '2000', lastCheckedPostId: '2000', firstPostId: '2000', revision: 'legacy-200'}),
      dbPut('topics', {topicId: '300', title: 'Alpha legacy topic', url: 'https://4pda.to/forum/index.php?showtopic=300', lastPostId: '3000', lastCheckedPostId: '3000', firstPostId: '3000', revision: 'legacy-300'})
    ])""")
    ui.reload()
    ui.locator(".topic-row").nth(1).wait_for()
    legacy_order = ui.locator(".topic-row").evaluate_all("rows => rows.map(row => row.dataset.topicId)")
    ui.reload()
    ui.locator(".topic-row").nth(1).wait_for()
    assert legacy_order == ["300", "200"]
    assert ui.locator(".topic-row").evaluate_all("rows => rows.map(row => row.dataset.topicId)") == legacy_order
    print("PASS MV3 legacy topics without sortOrder render in stable order")

    start("add")
    assert completed()["state"] == "done"
    added = worker.evaluate("dbGet('topics', '1109483')")
    assert added["lastPostId"] == "13" and added["lastCheckedPostId"] == "13", added
    assert added["sortOrder"] == 0, added
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.title)") == "First real topic"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    ui.locator(".topic-row").nth(2).wait_for()
    assert ui.locator(".topic-row").evaluate_all("rows => rows.map(row => row.dataset.topicId)") == ["300", "200", "1109483"]
    print("PASS MV3 add from extension page: latest baseline, no history import")

    topics_before_drag = worker.evaluate("dbGetAll('topics')")
    ui.locator('[data-drag-topic="1109483"]').drag_to(
        ui.locator('[data-topic-id="300"]'), target_position={"x": 10, "y": 1})
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        order = worker.evaluate("dbGetAll('topics').then(sortTopics).then(rows => rows.map(row => row.topicId))")
        if order == ["1109483", "300", "200"]:
            break
        ui.wait_for_timeout(50)
    assert order == ["1109483", "300", "200"], order
    topics_after_drag = worker.evaluate("dbGetAll('topics')")
    before_by_id = {topic["topicId"]: {key: value for key, value in topic.items() if key != "sortOrder"} for topic in topics_before_drag}
    after_by_id = {topic["topicId"]: {key: value for key, value in topic.items() if key != "sortOrder"} for topic in topics_after_drag}
    assert after_by_id == before_by_id
    ui.reload()
    ui.locator(".topic-row").nth(2).wait_for()
    assert ui.locator(".topic-row").evaluate_all("rows => rows.map(row => row.dataset.topicId)") == order
    with context.expect_page() as opened_info:
        ui.locator('[data-topic-id="1109483"] [data-open]').click()
    opened_info.value.close()
    start("checkAll")
    ordered_check = completed()
    assert [result["topicId"] for result in ordered_check["results"]] == order
    worker.evaluate("Promise.all([dbDelete('topics', '200'), dbDelete('topics', '300')])")
    ui.reload()
    ui.locator(".topic-row").wait_for()
    print("PASS MV3 drag order persists, preserves topic data, keeps buttons working and orders check-all")

    forum_titles["1109483"] = "Updated real topic"
    start("check")
    assert completed()["state"] == "done"
    saved = worker.evaluate("dbGet('topics', '1109483')")
    assert saved["title"] == "Updated real topic" and saved["lastPostId"] == "13", saved
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    print("PASS MV3 successful check refreshes title without marker or history changes")

    pages[4] = ["10", "14", "15"]
    pages[6] = ["10", "16", "17"]
    fail_page[0] = ("1109483", 4)
    start("check")
    assert completed()["state"] == "error"
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.lastPostId)") == "13"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 0
    print("PASS MV3 failed page: no batch or marker advancement")

    fail_page[0] = None
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

    # Legacy batches without reviewed are unreviewed; toggling persists while
    # preserving every collection field.
    review_button = ui.locator("[data-reviewbatch]")
    assert review_button.inner_text() == "Разобрано" and review_button.get_attribute("aria-pressed") == "false"
    batch_before_review = worker.evaluate("dbGetAll('batches').then(rows => rows[0])")
    review_button.click()
    ui.locator('[data-reviewbatch][aria-pressed="true"]').wait_for()
    reviewed = worker.evaluate("batchId => dbGet('batches', batchId)", batch_before_review["batchId"])
    assert reviewed.get("reviewed") is True
    assert {key: value for key, value in reviewed.items() if key != "reviewed"} == batch_before_review
    ui.reload()
    review_button = ui.locator('[data-reviewbatch][aria-pressed="true"]')
    review_button.wait_for()
    assert review_button.inner_text() == "✓ Разобрано" and "reviewed" in ui.locator(".batch-row").get_attribute("class").split()
    review_button.click()
    ui.locator('[data-reviewbatch][aria-pressed="false"]').wait_for()
    unreviewed = worker.evaluate("batchId => dbGet('batches', batchId)", batch_before_review["batchId"])
    assert unreviewed.get("reviewed") is False
    assert {key: value for key, value in unreviewed.items() if key != "reviewed"} == batch_before_review
    print("PASS MV3 batch reviewed toggle persists and preserves collection data")

    start("check")
    assert completed()["state"] == "done"
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 1
    start("reset")
    assert completed()["state"] == "done"
    reset_topic = worker.evaluate("dbGet('topics', '1109483')")
    assert reset_topic["lastPostId"] == "17" and reset_topic["lastCheckedPostId"] == "17", reset_topic
    assert worker.evaluate("dbGetAll('batches').then(b => b.length)") == 1
    print("PASS MV3 repeat and reset preserve history without duplicate batches")

    # Count-only workflow: 8, then 6 more, then no change.
    pages[8] = ["10", "18", "19", "20", "21", "22", "23", "24", "25"]
    before_posts = worker.evaluate("dbGetAll('posts').then(rows => rows.length)")
    before_batches = worker.evaluate("dbGetAll('batches').then(rows => rows.length)")
    start("checkAll")
    blocked = ui.evaluate("chrome.runtime.sendMessage({type: 'start', command: 'collectAll'})")
    assert blocked.get("error"), blocked
    # The all-topic operation is owned by the worker, not by the initiating page.
    ui.close()
    ui = context.new_page()
    ui.goto(f"chrome-extension://{extension_id}/options.html")
    check = completed()
    first = next(item for item in check["results"] if item["topicId"] == "1109483")
    assert (first["totalUncollected"], first["sinceLastCheck"]) == (8, 8), first
    saved = worker.evaluate("dbGet('topics', '1109483')")
    assert saved["lastPostId"] == "17" and saved["lastCheckedPostId"] == "25", saved
    assert worker.evaluate("dbGetAll('posts').then(rows => rows.length)") == before_posts
    assert worker.evaluate("dbGetAll('batches').then(rows => rows.length)") == before_batches
    assert check.get("lastSuccessfulCheckAt"), check
    popup = context.new_page()
    popup.goto(f"chrome-extension://{extension_id}/popup.html")
    popup.locator('#topicResults .result-row').wait_for()
    assert popup.locator('#checkAll').inner_text() == 'Проверить новое'
    assert popup.locator('#collectAll').inner_text() == 'Собрать всё'
    assert '8 (+8)' in popup.locator('#topicResults').inner_text()
    popup.close()

    pages[8] = ["10", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31"]
    start("checkAll")
    second = next(item for item in completed()["results"] if item["topicId"] == "1109483")
    assert (second["totalUncollected"], second["sinceLastCheck"]) == (14, 6), second
    start("checkAll")
    third = next(item for item in completed()["results"] if item["topicId"] == "1109483")
    assert (third["totalUncollected"], third["sinceLastCheck"]) == (14, 0), third
    assert worker.evaluate("dbGet('topics', '1109483').then(t => t.lastPostId)") == "17"
    print("PASS MV3 check-all counts 8, then +6, then +0 without posts, batches or lastPostId changes")

    # Legacy topic without lastCheckedPostId uses lastPostId, then an interrupted
    # check and collection leave their respective markers unchanged.
    topic_pages["999"] = {0: ["100", "101"], 2: ["100", "102"]}
    forum_titles["999"] = "Legacy topic"
    worker.evaluate("dbPut('topics', {topicId: '999', title: 'Legacy topic', url: 'https://4pda.to/forum/index.php?showtopic=999', lastPostId: '101', firstPostId: '100', addedAt: new Date().toISOString()})")
    start("checkAll")
    legacy = next(item for item in completed()["results"] if item["topicId"] == "999")
    assert (legacy["totalUncollected"], legacy["sinceLastCheck"]) == (1, 1), legacy
    assert worker.evaluate("dbGet('topics', '999').then(t => t.lastCheckedPostId)") == "102"
    topic_pages["999"][4] = ["100", "103"]
    fail_page[0] = ("999", 4)
    start("checkAll")
    failed_check = completed()
    assert next(item for item in failed_check["results"] if item["topicId"] == "999")["state"] == "error"
    assert worker.evaluate("dbGet('topics', '999').then(t => t.lastCheckedPostId)") == "102"
    assert failed_check.get("lastSuccessfulCheckAt"), failed_check
    print("PASS MV3 legacy marker fallback and failed check preserve lastCheckedPostId")

    # One failed topic does not roll back an already collected topic.
    batches_before_all = worker.evaluate("dbGetAll('batches').then(rows => rows.length)")
    start("collectAll")
    partial = completed()
    assert next(item for item in partial["results"] if item["topicId"] == "999")["state"] == "error"
    primary = worker.evaluate("dbGet('topics', '1109483')")
    legacy_topic = worker.evaluate("dbGet('topics', '999')")
    assert primary["lastPostId"] == "31" and primary["lastCheckedPostId"] == "31", primary
    assert legacy_topic["lastPostId"] == "101", legacy_topic
    assert worker.evaluate("dbGetAll('batches').then(rows => rows.length)") == batches_before_all + 1

    fail_page[0] = None
    start("collectAll")
    assert completed()["state"] == "done"
    legacy_topic = worker.evaluate("dbGet('topics', '999')")
    assert legacy_topic["lastPostId"] == "103" and legacy_topic["lastCheckedPostId"] == "103", legacy_topic
    assert worker.evaluate("dbGetAll('batches').then(rows => rows.length)") == batches_before_all + 2
    start("collectAll")
    assert completed()["state"] == "done"
    assert worker.evaluate("dbGetAll('batches').then(rows => rows.length)") == batches_before_all + 2
    print("PASS MV3 collect-all isolates failures, syncs both markers and creates no empty batches")

    # Backup download contains complete IndexedDB records but no session job.
    worker.evaluate("dbGetAll('batches').then(rows => dbPut('batches', {...rows[0], reviewed: true}))")
    ui.reload()
    ui.locator("#exportBackup").wait_for()
    expected_data = worker.evaluate("Promise.all([dbGetAll('topics'), dbGetAll('posts'), dbGetAll('batches')])")
    with ui.expect_download() as backup_download:
        ui.locator("#exportBackup").click()
    backup = json.loads(Path(backup_download.value.path()).read_text(encoding="utf-8"))
    assert backup["format"] == "4pda-tracker-backup" and backup["backupVersion"] == 1
    assert backup["data"] == dict(zip(("topics", "posts", "batches"), expected_data))
    assert set(backup) == {"format", "backupVersion", "exportedAt", "data"}
    assert any("lastPostId" in topic and "lastCheckedPostId" in topic and "sortOrder" in topic for topic in backup["data"]["topics"])
    assert any(batch.get("reviewed") is True for batch in backup["data"]["batches"])
    print("PASS MV3 backup download contains complete stores and excludes session status")

    state_before_import = worker.evaluate("Promise.all([dbGetAll('topics'), dbGetAll('posts'), dbGetAll('batches')])")
    ui.locator("#backupFile").set_input_files({"name": "broken.json", "mimeType": "application/json", "buffer": b"{"})
    ui.locator("#backupStatus.error").wait_for()
    assert worker.evaluate("Promise.all([dbGetAll('topics'), dbGetAll('posts'), dbGetAll('batches')])") == state_before_import

    replacement = {
        "format": "4pda-tracker-backup",
        "backupVersion": 1,
        "exportedAt": "2026-09-13T12:00:00.000Z",
        "data": {
            "topics": [
                {"topicId": "restore-a", "url": "https://4pda.to/forum/index.php?showtopic=700", "title": "Second", "lastPostId": "701", "lastCheckedPostId": "702", "sortOrder": 1},
                {"topicId": "restore-b", "url": "https://4pda.to/forum/index.php?showtopic=800", "title": "First", "lastPostId": "801", "lastCheckedPostId": "802", "sortOrder": 0},
            ],
            "posts": [{"postId": "801", "topicId": "restore-b", "text": "restored post"}],
            "batches": [{"batchId": "restore-batch", "topicId": "restore-b", "createdAt": "2026-09-13T10:00:00.000Z", "postIds": ["801"], "reviewed": True}],
        },
    }
    replacement_file = {"name": "backup.json", "mimeType": "application/json", "buffer": json.dumps(replacement).encode("utf-8")}
    ui.once("dialog", lambda dialog: dialog.dismiss())
    ui.locator("#backupFile").set_input_files(replacement_file)
    ui.wait_for_timeout(200)
    assert worker.evaluate("Promise.all([dbGetAll('topics'), dbGetAll('posts'), dbGetAll('batches')])") == state_before_import
    print("PASS MV3 cancelled backup restore leaves all stores unchanged")

    ui.once("dialog", lambda dialog: dialog.accept())
    ui.locator("#backupFile").set_input_files(replacement_file)
    ui.locator("#backupStatus.ok").filter(has_text="успешно восстановлены").wait_for()
    restored_data = worker.evaluate("Promise.all([dbGetAll('topics'), dbGetAll('posts'), dbGetAll('batches')])")
    assert restored_data == [replacement["data"]["topics"], replacement["data"]["posts"], replacement["data"]["batches"]]
    assert ui.locator(".topic-row").evaluate_all("rows => rows.map(row => row.dataset.topicId)") == ["restore-b", "restore-a"]
    assert ui.locator('[data-reviewbatch][aria-pressed="true"]').inner_text() == "✓ Разобрано"
    assert worker.evaluate("dbGet('topics', '1109483')") is None
    print("PASS MV3 confirmed backup restore replaces data and renders saved order and reviewed state")
    context.close()
