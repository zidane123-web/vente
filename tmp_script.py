import pathlib, re
text = pathlib.Path('index.html').read_text(encoding='utf-8')
m = re.search(r"commande' \? '(.+?)' : '(.+?)'", text)
if m:
    for g in m.groups():
        print(g.encode('unicode_escape').decode())
