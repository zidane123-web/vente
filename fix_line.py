from pathlib import Path
path = Path("index.html")
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
lines[7047] = """    container.innerHTML = `<div class="close-day-empty">Aucune transaction enregistrée aujourd'hui.</div>`;\r\n"""
path.write_text(''.join(lines), encoding="utf-8")
