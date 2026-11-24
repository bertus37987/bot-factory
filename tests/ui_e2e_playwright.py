import os
import sys
from playwright.sync_api import expect, sync_playwright


def require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return val


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

        expect(page.locator(".app-shell-v3")).to_be_visible()
        expect(page.locator(".icon-rail")).to_be_visible()
        expect(page.locator(".center-header")).to_contain_text("Main Agent")
        expect(page.locator(".hydration-shell")).to_have_count(0)
        expect(page.locator(".auth-gate-backdrop")).to_have_count(0)
        expect(page.locator(".ws-banner")).to_have_count(0)

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

        # 3. Send a message in Main Agent (ChatTab) via PrecisionComposer
        chat_pane = page.locator(".world-pane:not(.hidden)")
        chat_input = chat_pane.locator("textarea.pc-input")
        user_prompt = "Hello Main Agent, verify workspace status for Playwright."
        chat_input.fill(user_prompt)
        chat_input.press("Enter")

        expect(chat_pane.locator(".chat-turn.user")).to_contain_text(user_prompt)
        assistant_turn = chat_pane.locator(".chat-turn.assistant .chat-prose-assistant").last
        expect(assistant_turn).to_be_visible()
        expect(assistant_turn).not_to_be_empty()

        # 4. Open Docs, Image, 3D Model, and Diff in 2-row In-App Browser; toggle Annotate + add pin
        sidebar.locator("button.drawer-item", has_text="roadmap.md").click()
        browser_pane = page.locator(".browser-sidebar-pane")
        expect(browser_pane).to_be_visible()
        expect(browser_pane.locator(".browser-chrome-tabs")).to_be_visible()
        expect(browser_pane.locator(".browser-chrome-nav")).to_be_visible()

        doc_block = browser_pane.locator(".iab-doc-stage .doc-block").first
        expect(doc_block).to_be_visible()

        annotate_btn = browser_pane.locator(".iab-annotate-toggle")
        expect(annotate_btn).to_be_enabled()
        annotate_btn.click()
        expect(annotate_btn).to_have_attribute("aria-pressed", "true")
        expect(browser_pane.locator(".iab-stage-hint")).to_be_visible()

        doc_block.click()
        ann_dialog = browser_pane.get_by_role("dialog", name="New annotation pin")
        expect(ann_dialog).to_be_visible()
        ann_dialog.locator("textarea.iab-composer-text").fill("Verify roadmap milestone phrasing.")
        ann_dialog.get_by_role("button", name="Submit Fix Pin").click()
        expect(ann_dialog).to_have_count(0)
        expect(browser_pane.locator(".iab-pins-btn")).to_contain_text("Pins (1)")
        annotate_btn.click()
        expect(annotate_btn).to_have_attribute("aria-pressed", "false")

        # Image viewer (ui-mockup.svg)
        sidebar.locator("button.drawer-item", has_text="ui-mockup.svg").click()
        expect(browser_pane.locator(".iab-image-stage")).to_be_visible()
        expect(browser_pane.locator(".image-zoom-toolbar")).to_be_visible()
        img_el = browser_pane.locator(".iab-image-stage img")
        expect(img_el).to_be_visible()
        expect(img_el).to_have_js_property("complete", True)
        natural_w = img_el.evaluate("el => el.naturalWidth")
        if not isinstance(natural_w, (int, float)) or natural_w <= 0:
            raise AssertionError(f"Expected ui-mockup.svg naturalWidth > 0, got {natural_w}")
        img_box = img_el.bounding_box()
        if not img_box or img_box["width"] <= 0 or img_box["height"] <= 0:
            raise AssertionError(f"Expected ui-mockup.svg non-zero bounding box, got {img_box}")

        # 3D Model viewer (hero-monolith.glb) — verify lazy Three.js chunk + canvas mount
        sidebar.locator("button.drawer-item", has_text="hero-monolith.glb").click()
        model_stage = browser_pane.locator(".model3d-stage")
        expect(model_stage).to_be_visible()
        canvas_el = model_stage.locator("canvas")
        expect(canvas_el).to_be_visible()
        box = canvas_el.bounding_box()
        if not box or box["width"] <= 0 or box["height"] <= 0:
            raise AssertionError(f"Expected 3D canvas non-zero bounding box, got {box}")
        expect(browser_pane.locator(".model3d-preset-toolbar")).to_be_visible()
        expect(browser_pane.locator(".iab-3d-hud")).to_contain_text("GLB loaded")

        # Diff viewer
        sidebar.locator("button.drawer-item", has_text="Git Diff").click()
        expect(browser_pane.locator(".iab-diff-stage")).to_be_visible()
        expect(browser_pane.locator(".iab-diff-meta")).to_be_visible()

        # Close browser sidebar cleanly
        browser_pane.locator(".iab-close").click()
        expect(browser_pane).to_have_count(0)

        # 5. Switch via 44px icon rail to Bots Page -> Group Chat -> Spawn Atlas -> Workspace views
        page.locator('nav.icon-rail button[aria-label="Engineering Teams"]').click()
        bots_shell = page.locator(".bots-center-shell")
        expect(bots_shell).to_be_visible()
        expect(bots_shell.locator(".group-target-strip")).to_be_visible()
        expect(bots_shell.locator(".bcs-root")).to_be_visible()
        if bots_shell.locator(".group-msg-row").count() == 0:
            expect(bots_shell.locator(".bcs-empty-title")).to_contain_text("Group Chat")

        # Click + Bot to open BotSpawnModal and spawn peer bot "Atlas"
        bots_shell.locator('button[title="Spawn a new project bot"]').click()
        spawn_dialog = page.get_by_role("dialog", name="Spawn Project Bot")
        expect(spawn_dialog).to_be_visible()
        spawn_dialog.get_by_placeholder("e.g. Forge-2").fill("Atlas")
        spawn_dialog.get_by_role("button", name="Spawn Bot").click()
        expect(spawn_dialog).to_have_count(0)

        expect(sidebar).to_contain_text("Atlas")
        expect(page.locator(".center-header-title")).to_contain_text("Atlas")

        # Open Task Board, Checkpoints & Merge, Debates & Verifier, Self-Mod Sandbox
        sidebar.locator("button.drawer-item", has_text="Task Board").click()
        expect(page.locator(".center-header-title")).to_contain_text("Task Board")
        expect(bots_shell.locator(".kanban-grid")).to_be_visible()

        sidebar.locator("button.drawer-item", has_text="Checkpoints & Merge").click()
        expect(page.locator(".center-header-title")).to_contain_text("Checkpoints & Merge")
        expect(bots_shell.locator(".checkpoints-panel")).to_be_visible()
        expect(bots_shell).to_contain_text("Verified Merge Queue")

        sidebar.locator("button.drawer-item", has_text="Debates & Verifier").click()
        expect(page.locator(".center-header-title")).to_contain_text("Debates & Verifier")
        expect(bots_shell).to_contain_text("Conflict Debates")
        expect(bots_shell).to_contain_text("Independent Verifier")

        sidebar.locator("button.drawer-item", has_text="Self-Mod Sandbox").click()
        expect(page.locator(".center-header-title")).to_contain_text("Self-Mod Sandbox")
        expect(bots_shell).to_contain_text("Self-Mod Staging (Sandbox)")
        expect(bots_shell).to_contain_text("Self-Mod Pipeline")

        # 6. Open Escalation Inbox
        page.locator('nav.icon-rail button[data-inbox-trigger="true"]').click()
        inbox_dialog = page.get_by_role("dialog", name="Escalation Inbox")
        expect(inbox_dialog).to_be_visible()
        inbox_dialog.get_by_role("button", name="Close escalation inbox").click()
        expect(inbox_dialog).to_have_count(0)

        # 7. Switch to Main Agent rail, open Memory L1 Studio -> edit + save USER.md -> verify saved
        page.locator('nav.icon-rail button[aria-label="Main Agent"]').click()
        sidebar.locator("button.drawer-item", has_text="Memory Studio").click()
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
        sidebar.locator("button.drawer-item", has_text="Memory Studio").click()
        memory_dialog = page.get_by_role("dialog", name="Memory Studio — L1 Prompt Files & L2 Live Facts")
        expect(memory_dialog.locator(".memory-studio-l1-col textarea")).to_have_value(l1_text)
        memory_dialog.get_by_role("button", name="Close Memory Studio").click()
        expect(memory_dialog).to_have_count(0)

        # 8. Open Settings (SettingsView) -> save OPENAI_API_KEY -> Configured -> secret never in DOM
        page.locator('nav.icon-rail button[aria-label="Settings"]').click()
        settings_dialog = page.get_by_role("dialog", name="Studio Settings & Open BYOS")
        expect(settings_dialog).to_be_visible()

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

        context.close()
        browser.close()

    if page_errors or console_errors:
        joined = "\n".join(page_errors + console_errors)
        raise AssertionError(f"Uncaught browser errors detected:\n{joined}")

    print("PLAYWRIGHT_STUDIO_E2E_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
