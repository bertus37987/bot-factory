import json
import os
import sys
from playwright.sync_api import expect, sync_playwright


def require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return val


def capture_studio(page, name):
    if directory := os.environ.get("BF_UI_CAPTURE_DIR"):
        page.screenshot(path=os.path.join(directory, f"{name}.png"), animations="disabled")


def open_bot_controls(scope):
    scope.locator(".bot-control-tab").click()


def check_team_inbox(page, sidebar, theme_toggle, capture_dir, steer_outbox, held_acks):
    bots = page.locator(".bots-center-shell")
    close_panel = page.locator(".drawer-close-btn")
    team = page.get_by_role("button", name="Switch team:")
    composer = bots.locator("textarea.pc-input")
    first = "Playwright Smoke Project"
    second = "Studio Research"

    page.get_by_role("button", name="Engineering Teams").click()
    sidebar.get_by_role("button", name="Group Chat").click()
    expect(bots.locator(".bots-compose-destination")).to_contain_text(first)

    # Truthful team seats: five members render three portraits + a compact overflow seat.
    for bot_name in ("Vega", "Nox", "Iris"):
        open_bot_controls(bots)
        bots.locator('button[title="Spawn a new project bot"]').click()
        spawn_dialog = page.get_by_role("dialog", name="Spawn Project Bot")
        spawn_dialog.get_by_placeholder("e.g. Forge-2").fill(bot_name)
        spawn_dialog.get_by_role("button", name="Spawn Bot").click()
        expect(spawn_dialog).to_have_count(0)
    sidebar.get_by_role("button", name="Group Chat").click()
    first_cluster = sidebar.locator(".bot-roster-row.active .bf-group-cluster")
    expect(first_cluster).to_have_attribute("aria-label", "Bot team (5)")
    expect(first_cluster.locator(".bf-group-overflow-cell")).to_have_text("+2")
    expect(first_cluster.locator(".bf-group-empty-cell")).to_have_count(0)

    composer.fill("Draft for the build team")
    close_panel.click()
    expect(sidebar).to_have_count(0)
    team.press("Enter")
    search = page.get_by_role("combobox", name="Find a team")
    expect(search).to_be_focused()
    search.press("Escape")
    expect(team).to_be_focused()

    page.get_by_role("button", name="Engineering Teams").click()
    sidebar.get_by_role("button", name="Project", exact=True).click()
    modal = page.get_by_role("dialog", name="Create Project Workspace")
    modal.get_by_placeholder("e.g. Payments API").fill(second)
    modal.get_by_role("button", name="Create Project").click()
    expect(modal).to_have_count(0)
    expect(team).to_contain_text(second)
    expect(composer).to_have_value("")
    second_cluster = sidebar.locator(".bot-roster-row.active .bf-group-cluster")
    expect(second_cluster).to_have_attribute("aria-label", "Bot team (1)")
    expect(second_cluster.locator(".bf-group-overflow-cell")).to_have_count(0)
    expect(second_cluster.locator(".bf-group-empty-cell")).to_have_count(0)
    expect(second_cluster.locator(".bear-avatar-wrap")).to_have_count(1)
    expect(sidebar).not_to_contain_text("Atlas")
    open_bot_controls(bots)
    expect(bots.get_by_label("Bot control target").locator("option")).to_have_count(1)
    composer.fill("Draft for the research team")

    team.click()
    search.press("ArrowUp")
    search.press("Enter")
    expect(team).to_be_focused()
    expect(team).to_contain_text(first)
    expect(composer).to_have_value("Draft for the build team")
    expect(sidebar).to_contain_text("Atlas")
    expect(bots.get_by_label("Bot control target").locator("option", has_text="Atlas")).to_have_count(1)
    bots.get_by_label("Bot control target").select_option(label="Atlas (idle)")
    sidebar.get_by_role("button", name="Task Board").click()
    expect(bots.locator(".todo-board-row", has_text="Playwright V2 Animated Todo")).to_be_visible()

    team.click()
    search.fill("research")
    search.press("Enter")
    expect(composer).to_have_value("Draft for the research team")
    expect(bots.get_by_label("Bot control target").locator("option", has_text="Atlas")).to_have_count(0)
    sidebar.get_by_role("button", name="Task Board").click()
    expect(bots.locator(".todo-board-row", has_text="Playwright V2 Animated Todo")).to_have_count(0)
    sidebar.get_by_role("button", name="Group Chat").click()
    assert not steer_outbox, "Team changes must not dispatch a steer"
    composer.fill("Sentinel failed steer")
    composer.press("Enter")
    expect(bots.get_by_text("Simulated send rejection")).to_be_visible()
    expect(composer).to_have_value("Sentinel failed steer")
    assert len(steer_outbox) == 1

    bots.get_by_role("button", name="ui-mockup.svg").click()
    page.locator(".iab-image-toolbar").get_by_role("button", name="Add to Studio Research team").click()
    chips = bots.get_by_test_id("pc-attachments")
    expect(chips).to_contain_text("ui-mockup.svg")
    page.get_by_role("button", name="Close browser").click()

    composer.fill("Which findings should we include in the release brief?")
    composer.press("Enter")
    expect(bots.locator(".bcs-bubble.human")).to_contain_text("release brief")
    expect(bots.get_by_role("status").filter(has_text="Sending...")).to_be_visible()
    team.click()
    search.fill("playwright")
    search.press("Enter")
    expect(composer).to_have_value("Draft for the build team")
    expect(chips).to_have_count(0)
    assert len(held_acks) == 1
    socket, ack = held_acks.pop()
    socket.send(ack)
    team.click()
    search.fill("research")
    search.press("Enter")
    expect(composer).to_have_value("")
    expect(chips).to_have_count(0)
    expect(bots.locator(".bcs-bubble.bot").first).to_be_visible()
    trace = bots.locator(".bcs-trace-head").first
    expect(trace).to_be_visible()
    trace.click()
    expect(trace).to_have_attribute("aria-expanded", "true")
    trace.click()
    expect(trace).to_have_attribute("aria-expanded", "false")
    toasts = page.get_by_role("button", name="Dismiss notification")
    for _ in range(toasts.count()):
        toasts.first.click()
    if capture_dir:
        page.screenshot(path=os.path.join(capture_dir, "bots-team-chat-vanta.png"), animations="disabled")
    theme_toggle.click()
    expect(page.locator("html")).to_have_attribute("data-theme", "light")
    if capture_dir:
        page.screenshot(path=os.path.join(capture_dir, "bots-team-chat-light.png"), animations="disabled")
    theme_toggle.click()

    close_panel.click()
    page.set_viewport_size({"width": 1024, "height": 768})
    expect(page.get_by_test_id("split-chat-toggle-btn")).to_have_count(0)
    expect(page.locator(".split-active")).to_have_count(0)
    expect(sidebar).to_have_count(0)
    team.click()
    expect(search).to_be_visible()
    if capture_dir:
        page.screenshot(path=os.path.join(capture_dir, "bots-team-switch-wide.png"), animations="disabled")
    search.press("Escape")

    page.emulate_media(reduced_motion="reduce")
    page.set_viewport_size({"width": 390, "height": 760})
    expect(page.locator(".split-active")).to_have_count(0)
    expect(page.get_by_test_id("split-chat-toggle-btn")).to_have_count(0)
    expect(team).to_be_visible()
    expect(composer).to_be_visible()
    team.click()
    expect(search).to_be_visible()
    expect(page.locator(".bots-team-pop")).to_have_css("animation-name", "none")
    if capture_dir:
        page.screenshot(path=os.path.join(capture_dir, "bots-team-switch-mobile.png"))
    search.press("Escape")
    if capture_dir:
        page.screenshot(path=os.path.join(capture_dir, "bots-team-chat-mobile.png"))
    assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
    page.get_by_role("button", name="Engineering Teams").click()
    expect(sidebar).to_be_visible()
    sidebar.get_by_role("button", name="Group Chat").click()
    expect(sidebar).to_have_count(0)

    composer.fill("Research notes\n" + "\n".join(f"Finding {i}: Check the implementation." for i in range(25)))
    composer.press("Enter")
    expect(bots.locator(".bcs-bubble.human").last).to_contain_text("Finding 24")
    scroll = bots.locator(".bots-center-scroll")
    scroll.evaluate("el => { el.scrollTop = 0; }")
    jump = bots.get_by_role("button", name="Jump to Latest")
    expect(jump).to_be_visible()
    composer.fill("New steer while reading older messages")
    composer.press("Enter")
    expect(bots.locator(".bcs-bubble.human").last).to_contain_text("New steer while reading")
    assert scroll.evaluate("el => el.scrollTop < 56")
    jump.click()
    expect(jump).to_have_count(0)
    assert scroll.evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop < 56")


def assert_all_images_loaded(page, *, require_bear_avatar: bool = True) -> None:
    if require_bear_avatar:
        plush_bodies = page.locator(".bear-avatar-wrap svg.bear-plush-body")
        if plush_bodies.count() == 0:
            raise AssertionError("Expected at least one .bear-avatar-wrap svg.bear-plush-body element")
        expect(plush_bodies.first).to_be_visible()
        eye_rigs = page.locator(".bear-avatar-wrap svg.bear-eye-rig")
        if eye_rigs.count() == 0:
            raise AssertionError("Expected at least one .bear-avatar-wrap svg.bear-eye-rig SVG element")
        expect(eye_rigs.first).to_be_visible()

    broken = page.evaluate(
        """() => {
            const out = [];
            for (const img of document.querySelectorAll('img')) {
                const style = window.getComputedStyle(img);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (!img.complete || img.naturalWidth <= 0) {
                    out.push({
                        src: img.getAttribute('src') || '',
                        className: img.className || '',
                        complete: img.complete,
                        naturalWidth: img.naturalWidth,
                    });
                }
            }
            return out;
        }"""
    )
    if broken:
        raise AssertionError(f"Broken <img> elements detected: {broken}")


def main() -> int:
    base_url = require_env("BASE_URL").rstrip("/")
    token = require_env("TOKEN")
    project_root = require_env("PROJECT_ROOT")
    if not os.path.isdir(project_root):
        raise RuntimeError(f"PROJECT_ROOT does not exist: {project_root}")

    page_errors: list[str] = []
    console_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(12_000)
        steer_outbox = []
        held_acks = []
        held_main_reply = []
        defer_main_reply = True

        def route_commands(socket):
            server = socket.connect_to_server()
            hold_commands = set()

            def from_page(message):
                data = json.loads(message)
                payload = data.get("payload", {})
                if payload.get("type") == "steer.submit":
                    steer_outbox.append(payload)
                if payload.get("type") == "steer.submit" and payload.get("message") == "Sentinel failed steer":
                    socket.send(json.dumps({
                        "kind": "ack",
                        "commandId": payload["commandId"],
                        "ok": False,
                        "error": "Simulated send rejection",
                    }))
                else:
                    if payload.get("type") == "steer.submit" and "release brief" in payload["message"]:
                        hold_commands.add(payload["commandId"])
                    server.send(message)

            def from_server(message):
                data = json.loads(message)
                if data.get("kind") == "ack" and data.get("commandId") in hold_commands:
                    held_acks.append((socket, message))
                elif (
                    defer_main_reply
                    and data.get("topic") == "chat:meta"
                    and data.get("eventType") == "chat.message"
                    and data["data"].get("role") == "assistant"
                    and "Hello Main Agent, verify workspace status for Playwright." in data["data"]["content"]
                ):
                    held_main_reply.append((socket, message))
                else:
                    socket.send(message)

            socket.on_message(from_page)
            server.on_message(from_server)

        page.route_web_socket("**/ws", route_commands)

        page.on("pageerror", lambda err: page_errors.append(f"pageerror: {err}"))
        page.on(
            "console",
            lambda msg: console_errors.append(f"console.error: {msg.text}")
            if msg.type == "error"
            else None,
        )

        # 1. Cookie redirect from /?token= to / and hydrated Studio shell
        page.goto(f"{base_url}/?token={token}", wait_until="domcontentloaded")
        page.wait_for_url(f"{base_url}/", timeout=10_000)

        shell = page.locator(".app-shell-v3")
        expect(shell).to_be_visible()
        rail = page.locator(".icon-rail")
        expect(rail).to_be_visible()
        for label in ("Main", "Teams", "Browser", "Search", "Inbox", "Memory", "Settings", "Theme"):
            expect(rail).to_contain_text(label)
        expect(page.locator(".center-header")).to_contain_text("Main Agent")
        expect(page.locator(".hydration-shell")).to_have_count(0)
        expect(page.locator(".auth-gate-backdrop")).to_have_count(0)
        expect(page.locator(".ws-banner")).to_have_count(0)

        # 1b. Vanta Black default theme + Light Mode toggle round-trip
        html_el = page.locator("html")
        expect(html_el).to_have_attribute("data-theme", "vanta")
        vanta_bg = shell.evaluate("el => getComputedStyle(el).backgroundColor")
        if vanta_bg != "rgb(0, 0, 0)":
            raise AssertionError(f"Expected Vanta Black canvas rgb(0, 0, 0), got {vanta_bg}")

        theme_toggle_btn = page.locator('[data-testid="theme-toggle-btn"]')
        expect(theme_toggle_btn).to_be_visible()
        theme_toggle_btn.click()
        expect(html_el).to_have_attribute("data-theme", "light")
        light_bg = shell.evaluate("el => getComputedStyle(el).backgroundColor")
        if light_bg != "rgb(255, 255, 255)":
            raise AssertionError(f"Expected Light Mode canvas rgb(255, 255, 255), got {light_bg}")

        theme_toggle_btn.click()
        expect(html_el).to_have_attribute("data-theme", "vanta")
        restored_bg = shell.evaluate("el => getComputedStyle(el).backgroundColor")
        if restored_bg != "rgb(0, 0, 0)":
            raise AssertionError(f"Expected restored Vanta Black canvas rgb(0, 0, 0), got {restored_bg}")

        # 1c. Bear avatars + SVG eye rigs + zero broken images
        assert_all_images_loaded(page, require_bear_avatar=True)

        # 2. + New Project -> ProjectModal -> submit -> verify in sidebar
        page.locator(".drawer-new-btn").click()
        proj_dialog = page.get_by_role("dialog", name="Create Project Workspace")
        expect(proj_dialog).to_be_visible()
        proj_dialog.get_by_placeholder("e.g. Payments API").fill("Playwright Smoke Project")
        seed_checkbox = proj_dialog.locator('input[type="checkbox"]')
        expect(seed_checkbox).to_be_checked()
        proj_dialog.get_by_role("button", name="Create Project").click()
        expect(proj_dialog).to_have_count(0)

        sidebar = page.locator(".side-drawer")
        expect(sidebar).to_contain_text("Playwright Smoke Project")
        expect(sidebar).to_contain_text("roadmap.md")
        expect(sidebar).to_contain_text("ui-mockup.svg")
        expect(sidebar).to_contain_text("hero-monolith.glb")

        # 3. Inspect the keyboard-accessible model target picker, then send a Main Agent message
        chat_pane = page.locator(".world-pane:not(.hidden)")
        model_btn = chat_pane.locator(".pc-model-btn")
        expect(model_btn).to_be_visible()
        model_btn.click()
        expect(model_btn).to_have_attribute("aria-expanded", "true")
        model_pop = page.locator('.pc-pop.pc-model-pop[role="dialog"]')
        expect(model_pop).to_be_visible()
        model_search = model_pop.get_by_role("combobox", name="Search models")
        expect(model_search).to_be_focused()
        options = model_pop.get_by_role("option")
        assert options.count() > 0
        assert model_pop.locator('[role="option"][aria-selected="true"]').count() > 0
        model_search.press("ArrowDown")
        assert (model_search.get_attribute("aria-activedescendant") or "").endswith("-option-1")
        model_search.fill("no-such-model-route")
        expect(model_pop.locator(".pc-model-empty")).to_contain_text("No models match")
        model_search.fill("")
        model_search.press("Escape")
        expect(model_pop).to_have_count(0)
        expect(model_btn).to_be_focused()
        expect(model_btn).to_have_attribute("aria-expanded", "false")

        chat_input = chat_pane.locator("textarea.pc-input")
        user_prompt = "Hello Main Agent, verify workspace status for Playwright."
        chat_input.fill(user_prompt)
        chat_input.press("Enter")

        user_bubble = chat_pane.locator(".chat-turn.user.msg-side-right").last
        expect(user_bubble).to_be_visible()
        expect(user_bubble).to_contain_text(user_prompt)

        main_portrait = page.get_by_role("button", name="Main Agent profile").locator(".bear-portrait-stage")
        expect(main_portrait).to_have_css("animation-name", "bear-work-command")
        page.emulate_media(reduced_motion="reduce")
        expect(main_portrait).to_have_css("animation-name", "none")
        page.emulate_media(reduced_motion="no-preference")
        defer_main_reply = False
        for socket, reply in held_main_reply:
            socket.send(reply)

        assistant_row = chat_pane.locator(".chat-turn.assistant.msg-side-left").last
        expect(assistant_row).to_be_visible()
        assistant_turn = assistant_row.locator(".chat-prose-assistant.role-orchestrator")
        expect(assistant_turn).to_be_visible()
        expect(assistant_turn).not_to_be_empty()
        expect(assistant_row.locator(".bear-eye-rig")).to_be_visible()
        expect(assistant_row.locator(".bear-portrait-stage")).to_have_css("animation-name", "none")
        assert_all_images_loaded(page, require_bear_avatar=True)
        expect(assistant_turn).to_have_css("background-color", "rgb(28, 28, 26)")
        capture_studio(page, "main-agent-vanta")
        theme_toggle_btn.click()
        expect(assistant_turn).to_have_css("background-color", "rgb(242, 240, 238)")
        capture_studio(page, "main-agent-light")
        theme_toggle_btn.click()

        page.get_by_role("button", name="Quick Jump", exact=True).click()
        palette = page.get_by_role("dialog", name="Quick Jump Palette")
        expect(palette).to_be_visible()
        expect(palette.get_by_role("textbox")).to_be_focused()
        capture_studio(page, "studio-quick-jump")
        page.keyboard.press("Escape")
        expect(palette).to_have_count(0)

        page.set_viewport_size({"width": 390, "height": 760})
        expect(chat_input).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
        capture_studio(page, "main-agent-mobile")
        page.set_viewport_size({"width": 1440, "height": 900})

        conversation = chat_pane.get_by_role("region", name="Main Agent conversation")
        chat_input.fill("Implementation review\n" + "\n".join(f"Review point {i}" for i in range(60)))
        chat_input.press("Enter")
        expect(user_bubble).to_contain_text("Review point 59")
        conversation.evaluate("el => { el.scrollTop = 0; }")
        jump = chat_pane.get_by_role("button", name="Jump to Latest")
        expect(jump).to_be_visible()
        chat_input.fill("Keep my place while this response arrives.")
        chat_input.press("Enter")
        expect(user_bubble).to_contain_text("Keep my place")
        expect(assistant_turn).to_contain_text("Keep my place")
        assert conversation.evaluate("el => el.scrollTop < 56")
        jump.click()
        expect(jump).to_have_count(0)
        expect(conversation).to_be_focused()
        assert conversation.evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop < 56")

        # 4. Open Docs, Image, 3D Model, and Diff in 2-row In-App Browser (V2 Inline Edit + Comment->Chat)
        sidebar.locator("button.drawer-item", has_text="roadmap.md").click()
        browser_shell = page.locator('[data-testid="browser-workspace-shell"]')
        expect(browser_shell).to_be_visible()
        expect(browser_shell).to_have_attribute("data-dock-mode", "right")
        expect(browser_shell.locator(".browser-chrome-tabs")).to_be_visible()
        expect(browser_shell.locator(".browser-chrome-nav")).to_be_visible()

        # Verify legacy Annotate / Pins buttons and .browser-resize-gutter do NOT exist anywhere in DOM
        expect(page.locator(".iab-annotate-toggle")).to_have_count(0)
        expect(page.locator(".iab-pins-btn")).to_have_count(0)
        expect(page.get_by_role("button", name="Annotate")).to_have_count(0)
        expect(page.locator("button", has_text="Pins (")).to_have_count(0)
        expect(page.locator(".browser-resize-gutter")).to_have_count(0)

        doc_block = browser_shell.locator(".iab-doc-stage .doc-block").first
        expect(doc_block).to_be_visible()

        # 4a. Inline Doc edit + PUT /api/projects/:id/artifact save + preview verification
        browser_shell.locator('[data-testid="doc-edit-btn"]').click()
        doc_editor = browser_shell.locator('[data-testid="doc-editor-textarea"]')
        expect(doc_editor).to_be_visible()
        updated_marker = "Playwright V2 Inline Edit Verified"
        current_md = doc_editor.input_value()
        doc_editor.fill(f"{current_md}\n\n## {updated_marker}\nSaved via inline DocViewer editor.\n")
        expect(browser_shell.locator('[data-testid="doc-unsaved-indicator"]')).to_be_visible()

        with page.expect_response(
            lambda r: "/artifact" in r.url and r.request.method == "PUT"
        ) as put_resp_info:
            browser_shell.locator('[data-testid="doc-save-btn"]').click()
        put_resp = put_resp_info.value
        if put_resp.status != 200:
            raise AssertionError(f"Expected PUT /artifact 200, got {put_resp.status}")

        expect(doc_editor).to_have_count(0)
        expect(browser_shell.locator(".iab-doc-stage")).to_contain_text(updated_marker)

        # 4b. Inline Doc block hover -> Comment pill -> PrecisionComposer removable attachment chip
        doc_block = browser_shell.locator(".iab-doc-stage .doc-block").first
        doc_block.hover()
        comment_pill_btn = doc_block.get_by_role("button", name="Comment on block")
        expect(comment_pill_btn).to_be_visible()
        comment_pill_btn.click()

        doc_comment_dialog = browser_shell.get_by_role("dialog", name="Comment to chat")
        expect(doc_comment_dialog).to_be_visible()
        doc_comment_text = "Verify roadmap V2 inline comment chip."
        doc_comment_dialog.locator("textarea").fill(doc_comment_text)
        doc_comment_dialog.get_by_role("button", name="Add to Main Agent").click()
        expect(doc_comment_dialog).to_have_count(0)

        doc_chip = chat_pane.locator('[data-testid="pc-attachments"] .pc-att-chip').first
        expect(doc_chip).to_be_visible()
        expect(doc_chip).to_contain_text("roadmap.md")
        expect(doc_chip).to_contain_text(doc_comment_text)
        doc_chip_remove = doc_chip.locator(".pc-att-remove")
        expect(doc_chip_remove).to_be_visible()
        doc_chip_remove.click()
        expect(chat_pane.locator('[data-testid="pc-attachments"]')).to_have_count(0)

        # 4c. Image viewer (ui-mockup.svg) -> floating micro-toolbar + Add to Chat thumbnail chip
        sidebar.locator("button.drawer-item", has_text="ui-mockup.svg").click()
        expect(browser_shell.locator(".iab-image-stage")).to_be_visible()
        expect(browser_shell.locator(".image-zoom-toolbar")).to_be_visible()
        img_el = browser_shell.locator(".iab-image-stage img")
        expect(img_el).to_be_visible()
        expect(img_el).to_have_js_property("complete", True)
        natural_w = img_el.evaluate("el => el.naturalWidth")
        if not isinstance(natural_w, (int, float)) or natural_w <= 0:
            raise AssertionError(f"Expected ui-mockup.svg naturalWidth > 0, got {natural_w}")
        img_box = img_el.bounding_box()
        if not img_box or img_box["width"] <= 0 or img_box["height"] <= 0:
            raise AssertionError(f"Expected ui-mockup.svg non-zero bounding box, got {img_box}")

        img_toolbar = browser_shell.locator(".iab-image-toolbar")
        expect(img_toolbar).to_be_visible()
        expect(img_toolbar).to_contain_text("Comment")
        img_toolbar.get_by_role("button", name="Add to Main Agent").click()

        img_chip = chat_pane.locator('[data-testid="pc-attachments"] .pc-att-chip').first
        expect(img_chip).to_be_visible()
        expect(img_chip).to_contain_text("ui-mockup.svg")
        img_thumb = img_chip.locator("img.pc-att-thumb")
        expect(img_thumb).to_be_visible()
        expect(img_thumb).to_have_js_property("complete", True)
        thumb_nw = img_thumb.evaluate("el => el.naturalWidth")
        if not isinstance(thumb_nw, (int, float)) or thumb_nw <= 0:
            raise AssertionError(f"Expected composer thumbnail naturalWidth > 0, got {thumb_nw}")
        assert_all_images_loaded(page, require_bear_avatar=True)
        expect(chat_input).to_have_value("")
        attachment_send = chat_pane.get_by_role("button", name="Send message")
        expect(attachment_send).to_be_enabled()
        attachment_send.click()
        expect(chat_pane.locator('[data-testid="pc-attachments"]')).to_have_count(0)
        expect(chat_pane.locator(".chat-bubble-human").last).to_contain_text("ui-mockup.svg")

        # 4d. 3D Model viewer (hero-monolith.glb) — lazy Three.js chunk + canvas mount
        sidebar.locator("button.drawer-item", has_text="hero-monolith.glb").click()
        model_stage = browser_shell.locator(".model3d-stage")
        expect(model_stage).to_be_visible()
        canvas_el = model_stage.locator("canvas")
        expect(canvas_el).to_be_visible()
        box = canvas_el.bounding_box()
        if not box or box["width"] <= 0 or box["height"] <= 0:
            raise AssertionError(f"Expected 3D canvas non-zero bounding box, got {box}")
        expect(browser_shell.locator(".model3d-preset-toolbar")).to_be_visible()
        expect(browser_shell.locator(".iab-3d-hud")).to_contain_text("GLB loaded")
        capture_studio(page, "studio-browser")

        # 4e. Diff viewer
        sidebar.locator("button.drawer-item", has_text="Git Diff").click()
        expect(browser_shell.locator(".iab-diff-stage")).to_be_visible()
        expect(browser_shell.locator(".iab-diff-meta")).to_be_visible()

        # 4f. Browser 4-mode Dock switching (right -> bottom -> float -> fullscreen -> right)
        browser_shell.locator('[data-dock-btn="bottom"]').click()
        expect(browser_shell).to_have_attribute("data-dock-mode", "bottom")
        bottom_box = browser_shell.bounding_box()
        if not bottom_box or bottom_box["width"] <= 0 or bottom_box["height"] <= 0:
            raise AssertionError(f"Expected non-zero bottom dock bounding box, got {bottom_box}")

        browser_shell.locator('[data-dock-btn="float"]').click()
        expect(browser_shell).to_have_attribute("data-dock-mode", "float")
        expect(browser_shell.locator('[data-resize-handle="se"]')).to_be_visible()
        float_box = browser_shell.bounding_box()
        if not float_box or float_box["width"] <= 0 or float_box["height"] <= 0:
            raise AssertionError(f"Expected non-zero float dock bounding box, got {float_box}")

        browser_shell.locator('[data-dock-btn="fullscreen"]').click()
        expect(browser_shell).to_have_attribute("data-dock-mode", "fullscreen")
        expect(page.locator(".center-column")).to_be_hidden()

        browser_shell.locator('[data-dock-btn="right"]').click()
        expect(browser_shell).to_have_attribute("data-dock-mode", "right")
        expect(page.locator(".center-column")).to_be_visible()

        # Close browser sidebar cleanly
        browser_shell.locator(".iab-close").click()
        expect(browser_shell).to_have_count(0)

        # 4g. Contextual panel close/reopen, disabled split regression, and Main Agent profile motion
        page.locator(".drawer-close-btn").click()
        expect(page.locator(".side-drawer")).to_have_count(0)
        page.locator('nav.icon-rail button[aria-label="Main Agent"]').click()
        expect(page.locator(".side-drawer")).to_be_visible()

        expect(page.locator('[data-testid="split-chat-toggle-btn"]')).to_have_count(0)
        page.keyboard.press("Control+Shift+S")
        expect(page.locator(".world-container.split-active")).to_have_count(0)

        profile_btn = page.get_by_role("button", name="Main Agent profile")
        profile_btn.hover()
        expect(profile_btn.locator(".bear-portrait-stage")).to_have_css("animation-name", "bear-acknowledge")
        profile_btn.click()
        expect(page.get_by_role("region", name="Main Agent details")).to_contain_text("Orchestrator")
        capture_studio(page, "workspace-profile-main")
        page.keyboard.press("Escape")
        expect(profile_btn).to_be_focused()
        expect(profile_btn).to_have_attribute("aria-expanded", "false")
        page.emulate_media(reduced_motion="reduce")
        expect(profile_btn.locator(".bear-portrait-stage")).to_have_css("animation-name", "none")
        page.emulate_media(reduced_motion="no-preference")

        # 5. Switch via 44px icon rail to Engineering Teams -> verify NO "Debates & Verifier" -> Spawn Atlas -> TodoBoardView
        page.locator('nav.icon-rail button[aria-label="Engineering Teams"]').click()
        bots_shell = page.locator(".bots-center-shell")
        expect(bots_shell).to_be_visible()
        expect(bots_shell.locator(".bot-control-tab")).to_be_visible()
        expect(bots_shell.locator(".bcs-root")).to_be_visible()
        feed_items = bots_shell.locator(".group-msg-row, .bcs-artifact, .bcs-system, .bcs-verify, .bcs-trace")
        if feed_items.count() == 0:
            expect(bots_shell.locator(".bcs-empty-title")).to_contain_text("Group Chat")
            expect(bots_shell.locator(".bcs-empty .bear-avatar-wrap, .bcs-empty .bf-group-cluster").first).to_be_visible()
            expect(bots_shell.locator(".bcs-empty .bf-orb-shell")).to_have_count(0)
        else:
            expect(feed_items.first).to_be_visible()

        roster_avatars = sidebar.locator(".bot-roster-row > .bear-avatar-wrap")
        if roster_avatars.count() > 0:
            assert roster_avatars.first.evaluate("el => parseFloat(getComputedStyle(el).width)") >= 42

        expect(sidebar.locator("button.drawer-item", has_text="Debates & Verifier")).to_have_count(0)
        if "Debates & Verifier" in sidebar.inner_text():
            raise AssertionError("Legacy 'Debates & Verifier' entry must not exist in Engineering Teams sidebar")

        # Click + Bot to open BotSpawnModal and spawn peer bot "Atlas"
        open_bot_controls(bots_shell)
        bots_shell.locator('button[title="Spawn a new project bot"]').click()
        spawn_dialog = page.get_by_role("dialog", name="Spawn Project Bot")
        expect(spawn_dialog).to_be_visible()
        spawn_dialog.get_by_placeholder("e.g. Forge-2").fill("Atlas")
        spawn_dialog.get_by_role("button", name="Spawn Bot").click()
        expect(spawn_dialog).to_have_count(0)

        expect(sidebar).to_contain_text("Atlas")
        expect(page.locator(".center-header-title")).to_contain_text("Atlas")
        assert_all_images_loaded(page, require_bear_avatar=True)
        if capture_dir := os.environ.get("BF_UI_CAPTURE_DIR"):
            page.screenshot(path=os.path.join(capture_dir, "bots-desktop-vanta.png"))
            theme_toggle_btn.click()
            expect(html_el).to_have_attribute("data-theme", "light")
            page.screenshot(path=os.path.join(capture_dir, "bots-desktop-light.png"))
            theme_toggle_btn.click()

        # Task Board -> V2 TodoBoardView (quick-add, row expand, All / By Bot / By Status tabs)
        sidebar.locator("button.drawer-item", has_text="Task Board").click()
        expect(page.locator(".center-header-title")).to_contain_text("Task Board")
        expect(bots_shell.locator(".todo-board-root")).to_be_visible()
        expect(bots_shell.locator(".todo-board-header")).to_be_visible()
        expect(bots_shell.locator(".todo-board-progress-track")).to_be_visible()
        capture_studio(page, "studio-task-board")
        expect(bots_shell.locator(".kanban-grid")).to_have_count(0)

        quick_add_input = bots_shell.locator('[data-testid="todo-quick-add-input"]')
        expect(quick_add_input).to_be_visible()
        todo_title = "Playwright V2 Animated Todo"
        quick_add_input.fill(todo_title)
        bots_shell.locator('form.todo-board-quickadd button[type="submit"]').click()

        created_row = bots_shell.locator(".todo-board-row", has_text=todo_title)
        expect(created_row).to_be_visible()
        created_row.locator(".todo-board-title-btn").click()
        expect(created_row.locator(".todo-board-drawer-wrap.is-open")).to_be_visible()

        grouping_tabs = bots_shell.locator('[role="tablist"][aria-label="Todo board grouping"]')
        grouping_tabs.get_by_role("tab", name="By Bot").click()
        expect(grouping_tabs.get_by_role("tab", name="By Bot")).to_have_attribute("aria-selected", "true")
        expect(bots_shell.locator(".todo-board-section-head", has_text="Unassigned Queue")).to_be_visible()
        expect(bots_shell.locator(".todo-board-group-bot-btn", has_text="Atlas")).to_be_visible()

        grouping_tabs.get_by_role("tab", name="By Status").click()
        expect(grouping_tabs.get_by_role("tab", name="By Status")).to_have_attribute("aria-selected", "true")
        expect(bots_shell.locator(".todo-board-section", has_text="Ready / Backlog")).to_be_visible()

        grouping_tabs.get_by_role("tab", name="All").click()
        expect(grouping_tabs.get_by_role("tab", name="All")).to_have_attribute("aria-selected", "true")
        expect(bots_shell.locator(".todo-board-row", has_text=todo_title)).to_be_visible()

        # Checkpoints & Merge + Self-Mod Sandbox
        sidebar.locator("button.drawer-item", has_text="Checkpoints & Merge").click()
        expect(page.locator(".center-header-title")).to_contain_text("Checkpoints & Merge")
        expect(bots_shell.locator(".checkpoints-panel")).to_be_visible()
        expect(bots_shell).to_contain_text("Verified Merge Queue")

        sidebar.locator("button.drawer-item", has_text="Self-Mod Sandbox").click()
        expect(page.locator(".center-header-title")).to_contain_text("Self-Mod Sandbox")
        expect(bots_shell).to_contain_text("Self-Mod Staging (Sandbox)")
        expect(bots_shell).to_contain_text("Self-Mod Pipeline")

        # 6. Open Escalation Inbox
        page.locator('nav.icon-rail button[data-inbox-trigger="true"]').click()
        inbox_dialog = page.get_by_role("dialog", name="Escalation Inbox")
        expect(inbox_dialog).to_be_visible()
        capture_studio(page, "studio-inbox")
        inbox_dialog.get_by_role("button", name="Close escalation inbox").click()
        expect(inbox_dialog).to_have_count(0)

        # 7. Switch to Main Agent rail, open Memory L1 Studio -> edit + save USER.md -> verify saved
        page.locator('nav.icon-rail button[aria-label="Memory Studio"]').click()
        memory_dialog = page.get_by_role("dialog", name="Memory Studio — L1 Prompt Files & L2 Live Facts")
        expect(memory_dialog).to_be_visible()
        expect(memory_dialog.locator("button.subview-tab.active")).to_contain_text("USER.md")

        l1_text = "Playwright E2E preference: verify all studio panels with zero console errors."
        l1_textarea = memory_dialog.locator(".memory-studio-l1-col textarea")
        l1_textarea.fill(l1_text)
        memory_dialog.get_by_role("button", name="Save L1").click()
        expect(memory_dialog.locator(".pill.success")).to_contain_text("USER.md saved")

        # Re-open Memory Studio to confirm persisted state round-trip
        memory_dialog.get_by_role("button", name="Close Memory Studio").click()
        expect(memory_dialog).to_have_count(0)
        page.locator('nav.icon-rail button[aria-label="Memory Studio"]').click()
        memory_dialog = page.get_by_role("dialog", name="Memory Studio — L1 Prompt Files & L2 Live Facts")
        expect(memory_dialog.locator(".memory-studio-l1-col textarea")).to_have_value(l1_text)
        memory_dialog.get_by_role("button", name="Close Memory Studio").click()
        expect(memory_dialog).to_have_count(0)

        # 8. Open Settings (SettingsView) -> save OPENAI_API_KEY -> Configured -> secret never in DOM
        page.locator('nav.icon-rail button[aria-label="Settings"]').click()
        settings_dialog = page.get_by_role("dialog", name="Studio Settings & Open BYOS")
        expect(settings_dialog).to_be_visible()
        capture_studio(page, "studio-settings")

        settings_dialog.locator(".settings-tabs-bar button.subview-tab", has_text="API Keys").click()
        openai_card = settings_dialog.locator(".task-card").filter(
            has=page.locator("span", has_text="OPENAI_API_KEY")
        ).first
        expect(openai_card).to_be_visible()
        expect(openai_card.locator(".pill")).to_contain_text("Missing")

        test_secret = "sk-pw-e2e-writeonly-secret-424242"
        openai_card.locator('input[type="password"]').fill(test_secret)
        openai_card.get_by_role("button", name="Save Key").click()

        expect(
            settings_dialog.locator("div.pill.success").filter(has_text="Saved OPENAI_API_KEY.")
        ).to_contain_text("Saved OPENAI_API_KEY.")
        expect(openai_card.locator(".pill")).to_contain_text("Configured")

        # Verify plaintext secret string is NEVER rendered in DOM (text, HTML, or input values)
        leaked = page.evaluate(
            """(secret) => {
                if (document.documentElement.innerHTML.includes(secret)) return 'innerHTML';
                if ((document.body.innerText || '').includes(secret)) return 'innerText';
                for (const el of document.querySelectorAll('input, textarea')) {
                    if ((el.value || '').includes(secret)) return 'input_value';
                }
                return null;
            }""",
            test_secret,
        )
        if leaked is not None:
            raise AssertionError(f"Plaintext secret leaked in DOM via {leaked}!")

        settings_dialog.get_by_role("button", name="Close settings").click()
        expect(settings_dialog).to_have_count(0)

        check_team_inbox(page, sidebar, theme_toggle_btn, os.environ.get("BF_UI_CAPTURE_DIR"), steer_outbox, held_acks)
        projects = context.request.get(f"{base_url}/api/snapshot").json()["projects"]
        research_id = next(project["id"] for project in projects if project["name"] == "Studio Research")
        assert len(steer_outbox) == 4 and all(steer["projectId"] == research_id for steer in steer_outbox)
        assert "ui-mockup.svg" in steer_outbox[1]["message"]

        context.close()
        browser.close()

    if page_errors or console_errors:
        joined = "\n".join(page_errors + console_errors)
        raise AssertionError(f"Uncaught browser errors detected:\n{joined}")

    print("PLAYWRIGHT_STUDIO_E2E_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
