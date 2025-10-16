import pathlib

path = pathlib.Path("index.html")
text = path.read_text(encoding="utf-8", errors="ignore")
start = text.index("function marquerLivraisonReussie() {\n  ouvrirModalLivraisonEncaissement();\n}\n") + len("function marquerLivraisonReussie() {\n  ouvrirModalLivraisonEncaissement();\n}\n")
end = text.index("async function marquerLivraisonEchouee()")
if end <= start:
    raise SystemExit("unexpected positions")
text = text[:start] + text[end:]
path.write_text(text, encoding="utf-8")
