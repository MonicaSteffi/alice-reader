#!/usr/bin/env python3
"""Build the story and dialogue books for the reader app.

Usage:
    python3 tools/build_books.py           # writes books/stories.json and books/dialogues.json
    python3 tools/build_books.py --check   # lists words that are missing from tools/lexicon/*.txt

Content lives in tools/content/<book>/*.txt (see README in tools/). Every word needs an entry in
tools/lexicon/*.txt so that tapping it shows the base form, level and English meaning.
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

BOOKS = {
    'stories': {
        'title': 'Kurzgeschichten',
        'subtitle': 'Short stories A1 to C2',
        'out': 'books/stories.json',
        'parts': {
            'A1': 'Erste Schritte', 'A2': 'Alltag', 'B1': 'Unterwegs',
            'B2': 'Beruf und Nachbarn', 'C1': 'Entscheidungen', 'C2': 'Literarische Texte',
        },
    },
    'dialogues': {
        'title': 'Alltagsgespräche',
        'subtitle': 'Everyday conversations A1 to C1',
        'out': 'books/dialogues.json',
        'parts': {
            'A1': 'Im Café', 'A2': 'Gesundheit', 'B1': 'Wohnen',
            'B2': 'Kundenservice', 'C1': 'Im Beruf',
        },
    },
}

GRAMMAR = {
    'PRAES': 'Präsens',
    'NEG': 'nicht und kein',
    'W_FRAGE': 'W-Fragen',
    'TRENNBAR': 'trennbare Verben',
    'UHRZEIT': 'Uhrzeit',
    'MOECHTEN': 'möchten',
    'PERFEKT': 'Perfekt',
    'DATIV_PRAEP': 'Präpositionen mit Dativ',
    'DENN': 'denn',
    'WECHSELPRAEP': 'Wechselpräpositionen',
    'KOMPARATIV': 'Komparativ und Superlativ',
    'WEIL': 'Nebensatz mit weil',
    'PRAETERITUM': 'Präteritum',
    'DASS': 'Nebensatz mit dass',
    'KONJ2_WUERDE': 'Konjunktiv II mit würde',
    'PASSIV_PRAES': 'Passiv Präsens',
    'RELATIV': 'Relativsätze',
    'DAMIT_UMZU': 'damit und um … zu',
    'KONJ2_VERG': 'Konjunktiv II Vergangenheit',
    'PASSIV_MODAL': 'Passiv mit Modalverb',
    'KONJ1': 'Konjunktiv I (indirekte Rede)',
    'NOMEN_VERB': 'Nomen-Verb-Verbindungen',
    'JE_DESTO': 'je … desto',
    'PARTIZIP_ADJ': 'Partizip als Adjektiv',
    'ZWEITEILIG': 'zweiteilige Konnektoren',
    'PARTIZIPATTRIBUT': 'erweitertes Partizipialattribut',
    'KONNEKTOREN': 'zumal, wohingegen, insofern',
    'NOMINALSTIL': 'Nominalstil',
    'PASSIVERSATZ': 'Passiversatz',
    'FUNKTIONSVERB': 'Funktionsverbgefüge',
    'RELATIV_GENITIV': 'Relativsätze mit dessen und deren',
    'REDEWENDUNG': 'Redewendungen',
    'PARTIZIP_SATZ': 'Partizipialsätze',
    'MODALPARTIKEL': 'Modalpartikeln',
    'AKKUSATIV': 'Akkusativ',
    'ZAHLEN': 'Zahlen und Preise',
    'MODALVERB': 'Modalverben',
    'IMPERATIV': 'Imperativ',
    'INDIREKTE_FRAGE': 'indirekte Fragen',
    'KONJ2_HOEFLICH': 'höfliche Bitten mit Konjunktiv II',
    'SOLANGE': 'Nebensatz mit solange',
    'PASSIV_PRAET': 'Passiv Präteritum',
}

LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
WPM = {'A1': 60, 'A2': 75, 'B1': 90, 'B2': 110, 'C1': 120, 'C2': 130}
CONTENT_POS = {'NOUN', 'VERB', 'ADJ', 'ADV'}
ARTICLE = {'m': 'der', 'f': 'die', 'n': 'das', 'pl': 'die'}

# ---------------------------------------------------------------- lexicon
# Line format:  lemma | POS | level | English | gender | plural | extra forms (comma separated)
# Regular forms are generated: noun plural/dative/genitive, regular verb forms, adjective endings.

def adj_forms(base):
    return [base + e for e in ('e', 'en', 'er', 'es', 'em')]


def verb_forms(lemma):
    if lemma.endswith('eln') or lemma.endswith('ern'):
        stem = lemma[:-1]
        return [stem, stem[:-2] + 'le' if lemma.endswith('eln') else stem + 'e', stem + 'st', stem + 't', lemma,
                stem + 'te', stem + 'ten', stem + 'test', 'ge' + stem + 't']
    stem = lemma[:-2] if lemma.endswith('en') else lemma[:-1]
    e = 'e' if re.search(r'(t|d|chn|ffn|gn|dm|tm)$', stem) else ''
    forms = [stem + 'e', stem + e + 'st', stem + e + 't', lemma, stem + e + 'te', stem + e + 'ten', stem + e + 'test',
             stem + e + 'tet', 'ge' + stem + e + 't', 'zu ' + lemma]
    if lemma.endswith('ieren'):
        forms.append(stem + 't')
    return forms


def load_lexicon():
    entries = {}
    auto, explicit = {}, {}
    lines = []
    for f in sorted((ROOT / 'lexicon').glob('*.txt')):
        lines += [(f'{f.name}:{n}', raw) for n, raw in enumerate(f.read_text(encoding='utf-8').splitlines(), 1)]
    for n, raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        cols = [c.strip() for c in line.split('|')]
        cols += [''] * (7 - len(cols))
        lemma, pos, level, gloss, gender, plural, extra = cols[:7]
        if lemma in entries:
            raise SystemExit(f'{n}: duplicate lemma {lemma}')
        entries[lemma] = {'pos': pos, 'level': level, 'gloss': gloss, 'gender': gender or None, 'plural': plural or None}
        gen = [lemma]
        if pos == 'NOUN':
            if plural and plural != '-':
                gen += [plural, plural if plural.endswith(('n', 's')) else plural + 'n']
            gen += [lemma + 's', lemma + 'es', lemma + 'n', lemma + 'en']
        elif pos == 'VERB':
            gen += verb_forms(lemma)
        elif pos in ('ADJ',):
            gen += adj_forms(lemma)
        for f in gen:
            auto.setdefault(f, lemma)
        for f in [x.strip() for x in extra.split(',') if x.strip()]:
            explicit[f] = lemma
            if pos == 'ADJ' and f not in ('',):
                for g in adj_forms(f):
                    auto.setdefault(g, lemma)
    forms = {**auto, **explicit}
    for lemma in entries:
        forms[lemma] = lemma
    return entries, forms

# ---------------------------------------------------------------- text
WORD = r"[A-Za-zÄÖÜäöüßéè]+(?:[-'][A-Za-zÄÖÜäöüßéè]+)*-?"
TOKEN_RE = re.compile(rf"({WORD})(?:\{{([^}}]+)\}})?|(\d+)|(\S)")
CLOSING = {'“', '"', '«', '»', '’'}
END = {'.', '!', '?'}


def tokenize(text):
    out = []
    for m in TOKEN_RE.finditer(text):
        word, override, num, punct = m.groups()
        ws = ' ' if m.end() < len(text) and text[m.end()] == ' ' else ''
        if word:
            if word.endswith('-') and ws == '':  # hyphen glued to next word is not a word ending
                word = word[:-1]
                out.append({'surf': word, 'override': override, 'ws': ''})
                out.append({'surf': '-', 'punct': True, 'ws': ws})
                continue
            out.append({'surf': word, 'override': override, 'ws': ws})
        elif num:
            out.append({'surf': num, 'num': True, 'ws': ws})
        else:
            out.append({'surf': punct, 'punct': True, 'ws': ws})
    # remove spaces before the {override} marker effect: TOKEN_RE consumed it already
    return out


def split_sentences(tokens):
    sents, cur, i = [], [], 0
    while i < len(tokens):
        t = tokens[i]
        cur.append(t)
        if t.get('punct') and t['surf'] in END:
            j = i + 1
            while j < len(tokens) and tokens[j]['surf'] in CLOSING:
                cur.append(tokens[j]); j += 1
            if j < len(tokens) and tokens[j]['surf'] == ',':
                i = j; continue
            sents.append(cur); cur = []; i = j; continue
        i += 1
    if cur:
        sents.append(cur)
    return sents


def parse_file(path):
    head, body = path.read_text(encoding='utf-8').split('\n---\n', 1)
    meta = {'notes': [], 'grammar': [], 'story': []}
    for line in head.splitlines():
        if not line.strip():
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if k == 'note':
            meta['notes'].append(v)
        elif k == 'grammar':
            meta['grammar'] = [x.strip() for x in v.split('|') if x.strip()]
        elif k == 'story':
            meta['story'] = [x.strip() for x in v.split(',') if x.strip()]
        else:
            meta[k] = v
    return meta, body.strip('\n')


def blocks_of(body, dialogue):
    """Yield ('p', text) / ('line', speaker, text) / ('break',)."""
    if dialogue:
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            if line == '***':
                yield ('break',)
                continue
            speaker, text = line.split(':', 1)
            yield ('line', speaker.strip(), text.strip())
    else:
        for para in re.split(r'\n\s*\n', body):
            para = ' '.join(para.split())
            if para == '***':
                yield ('break',)
            elif para:
                yield ('p', para)


def lookup(tok, forms):
    if tok.get('override'):
        return tok['override']
    s = tok['surf']
    if s in forms:
        return forms[s]
    if s[0].isupper() and s.lower() in forms:
        return forms[s.lower()]
    if s.islower() and s.capitalize() in forms:
        return forms[s.capitalize()]
    return None


def build(check=False):
    entries, forms = load_lexicon()
    missing = {}
    results = {}
    for book_id, cfg in BOOKS.items():
        files = sorted((ROOT / 'content' / book_id).glob('*.txt'))
        dialogue = book_id == 'dialogues'
        chapters, man_chapters, parts = [], [], {}
        seen_lemmas = {}
        used_codes = {}
        lex_out, gloss_out = {}, {}
        for num, path in enumerate(files, 1):
            meta, body = parse_file(path)
            level = meta['level']
            story = set(meta['story'])
            sentences, blocks = [], []
            word_count = 0
            for b in blocks_of(body, dialogue):
                if b[0] == 'break':
                    blocks.append({'type': 'break'}); continue
                text = b[-1]
                start = len(sentences)
                for sent in split_sentences(tokenize(text)):
                    toks = []
                    first_word = next((k for k, x in enumerate(sent) if not x.get('punct')), 0)
                    for k, t in enumerate(sent):
                        # capitalised Sie inside a sentence is the formal "you"
                        if t['surf'] == 'Sie' and k != first_word and not t.get('override'):
                            t['override'] = 'Sie#formal'
                        if t.get('punct'):
                            toks.append([t['surf'], t['surf'], 'PUNCT', 'PUNCT', t['ws'], None, 0]); continue
                        if t.get('num'):
                            toks.append([t['surf'], t['surf'], 'NUM', 'NUM', t['ws'], None, 0]); word_count += 1; continue
                        lemma = lookup(t, forms)
                        word_count += 1
                        if lemma is None or lemma not in entries:
                            missing.setdefault(lemma or t['surf'], set()).add(f'{path.name}')
                            toks.append([t['surf'], lemma or t['surf'], 'X', 'OUT', t['ws'], None, 0]); continue
                        e = entries[lemma]
                        # lemma#tag marks a homograph: show the base form, carry its own meaning in the token
                        shown, own = (lemma.split('#')[0], e['gloss']) if '#' in lemma else (lemma, None)
                        toks.append([t['surf'], shown, e['pos'], e['level'], t['ws'], own, 1 if lemma in story else 0])
                    if toks:
                        toks[-1][4] = toks[-1][4] if b[0] == 'p' else toks[-1][4]
                    sentences.append({'tokens': toks, 'grammar': {}})
                end = len(sentences)
                sentences[-1]['tokens'][-1][4] = ''
                if b[0] == 'line':
                    blocks.append({'type': 'line', 'speaker': b[1], 'range': [start, end]})
                else:
                    blocks.append({'type': 'p', 'range': [start, end]})
            # vocabulary: first time a content word appears in this book
            new_vocab = []
            for si, s in enumerate(sentences):
                for ti, t in enumerate(s['tokens']):
                    lemma, pos, lv = t[1], t[2], t[3]
                    if pos not in CONTENT_POS or lv not in LEVEL_ORDER or lemma in seen_lemmas:
                        continue
                    seen_lemmas[lemma] = num
                    e = entries[lemma]
                    entry = lemma
                    if pos == 'NOUN' and e['gender']:
                        art = '/'.join(dict.fromkeys(ARTICLE[g] for g in e['gender'].split('/')))
                        entry = f"{art} {lemma}" + (f", die {e['plural']}" if e['plural'] and e['plural'] != '-' else '')
                    new_vocab.append({'entry': entry, 'lemma': lemma, 'level': lv, 'first': [si, ti],
                                      'deferred': False, 'gloss': e['gloss']})
            # show the words closest to the chapter level first, max 24
            target = LEVEL_ORDER.index(level)
            new_vocab.sort(key=lambda v: (abs(LEVEL_ORDER.index(v['level']) - target), v['first']))
            for v in new_vocab[24:]:
                v['deferred'] = True
            new_vocab.sort(key=lambda v: v['first'])
            for s in sentences:
                for t in s['tokens']:
                    if t[5] is None and t[1] in entries and t[1] not in lex_out:
                        e = entries[t[1]]
                        lex_out[t[1]] = [e['pos'], e['level'], e['gender'], None if e['plural'] == '-' else e['plural'], num]
                        if e['gloss']:
                            gloss_out[t[1]] = e['gloss']
            story_words = []
            for lemma in meta['story']:
                if lemma not in entries:
                    missing.setdefault(lemma, set()).add(path.name + ' (story)'); continue
                e = entries[lemma]
                word = f"{ARTICLE[e['gender'].split('/')[0]]} {lemma}" if e['pos'] == 'NOUN' and e['gender'] else lemma
                story_words.append({'word': word, 'lemma': lemma, 'gloss': e['gloss']})
            for code in meta['grammar']:
                if code not in GRAMMAR:
                    raise SystemExit(f'{path.name}: unknown grammar code {code}')
            grammar_new = [{'code': c, 'de': GRAMMAR[c]} for c in meta['grammar'] if c not in used_codes]
            for c in meta['grammar']:
                used_codes.setdefault(c, num)
            part_num = LEVEL_ORDER.index(level) + 1
            parts.setdefault(part_num, {'num': part_num, 'label': f'Teil {part_num}', 'level': level,
                                        'title': cfg['parts'][level], 'chapters': []})['chapters'].append(num)
            chapters.append({'num': num, 'sentences': sentences, 'blocks': blocks, 'new_vocab': new_vocab,
                             'notes': {'grammar': meta['notes'], 'story_words': story_words}})
            man_chapters.append({'num': num, 'title': meta['title'], 'level': level, 'part': part_num,
                                 'reading_minutes': max(1, math.ceil(word_count / WPM[level])), 'words': word_count,
                                 'grammar_new': grammar_new, 'kind': 'dialogue' if dialogue else 'story'})
        results[book_id] = {
            'format': 'alice-book', 'id': book_id, 'version': 1,
            'manifest': {'book': {'title': cfg['title'], 'subtitle': cfg['subtitle']},
                         'parts': [parts[k] for k in sorted(parts)], 'chapters': man_chapters,
                         'grammar_codes': {c: {'de': GRAMMAR[c]} for c in used_codes}},
            'lexicon': lex_out, 'glosses': gloss_out, 'chapters': chapters,
        }
    if missing:
        print(f'{len(missing)} words are missing from tools/lexicon/*.txt:', file=sys.stderr)
        for w in sorted(missing, key=str.lower):
            print(f'  {w}    ({", ".join(sorted(missing[w]))})', file=sys.stderr)
        if not check:
            raise SystemExit(1)
    if check:
        return
    for book_id, data in results.items():
        out = REPO / BOOKS[book_id]['out']
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        n = sum(len(s['tokens']) for c in data['chapters'] for s in c['sentences'])
        print(f'{out.relative_to(REPO)}: {len(data["chapters"])} chapters, {n} tokens, {len(data["lexicon"])} words')


if __name__ == '__main__':
    build(check='--check' in sys.argv)
