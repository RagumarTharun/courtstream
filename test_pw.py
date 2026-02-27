from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        
        errors = []
        page.on("pageerror", lambda err: errors.append(f"PAGE ERROR: {err}"))
        page.on("console", lambda msg: errors.append(f"CONSOLE: {msg.text}") if msg.type == "error" else None)
        
        page.goto("http://localhost:8080/scorekeeper.html")
        page.click('input[value="FIBA"]')
        page.fill('#draftNumber', '4')
        page.fill('#draftName', 'John')
        page.evaluate('addDraftPlayer()')
        page.evaluate('document.getElementById("draftTeamSelect").value = "B"')
        page.fill('#draftNumber', '5')
        page.fill('#draftName', 'Mike')
        page.evaluate('addDraftPlayer()')
        page.evaluate('startMatch()')
        
        try:
            page.evaluate('openLiveSheet()')
        except Exception as e:
            errors.append(f"EXCEPTION: {str(e)}")
            
        print("\n".join(errors))
        browser.close()

run()
