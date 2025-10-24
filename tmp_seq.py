import pathlib, collections, re
text=pathlib.Path('index.html').read_text(encoding='utf-8')
seqs = ['\xd4\xf6','\xd4\xc7','\xd4\xe5','\xd4\xa3','\xd4\xd7','\xd4\xe2','\xd4\xfb','\xd4\xeb','\xd4\xdc']
for seq in seqs:
    m = re.search('.{0,20}'+re.escape(seq)+'.{0,20}', text)
    if m:
        print(seq.encode('unicode_escape').decode(), '->', m.group(0).encode('unicode_escape').decode())
