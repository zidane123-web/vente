import pathlib, collections
text = pathlib.Path('index.html').read_text(encoding='utf-8')
weird_pairs = collections.Counter()
for i in range(len(text)-1):
    ch = text[i]
    if ord(ch) > 127:
        pair = text[i:i+2]
        weird_pairs[pair] += 1
print(len(weird_pairs))
for pair,count in weird_pairs.most_common(50):
    print(pair.encode('unicode_escape').decode(), count)
