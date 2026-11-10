# Alice reader

A small reading app for a graded German reader (levels A1 to B2). It runs in the browser, can be added to the iPhone Home Screen and works offline.

## What it does

- Book shelf: the books in the `books` folder are listed on the start screen. Tap one to open it; it is downloaded once and then works offline. Each book keeps its own progress and saved words. A book file can also be loaded from the Files app.
- Tap any word: basic form, article and plural for nouns, level, English meaning, the sentence, and read aloud.
- Read or Listen: in Listen mode a German voice reads the chapter sentence by sentence and highlights it. Tap a word to pause, see the English meaning and hear the word; closing the card continues. Speed: slow, normal, fast. The voice can be chosen in Aa or Settings.
- Saves your reading position, finished chapters, saved and known words, reading minutes and day streak.
- Backup and restore of your progress as one file (Settings).

## Add a book

1. Put the book file in the `books` folder, for example `books/alice.json`.
2. Add an entry to `books/index.json`:

```json
{ "id": "alice", "title": "Alice im Wunderland", "subtitle": "Leseroman", "level": "A1–B2", "file": "books/alice.json", "version": 1 }
```

`id` must be unique and must not change later (progress is stored under it). To publish a corrected book file, raise `version`; phones load the new file and keep the progress.

## Stories and dialogues

`books/stories.json` (12 short stories, A1–C2) and `books/dialogues.json` (5 everyday conversations, A1–C1) are built from the text files in `tools/content/`. Every chapter ends with grammar notes, a word list and a word quiz.

To change or add a story:

1. Edit or add a file in `tools/content/stories/` or `tools/content/dialogues/` (copy an existing one for the format; `word{lemma}` sets the base form, e.g. for separable verbs).
2. Run `python3 tools/build_books.py --check`. It lists every word that is not yet in `tools/lexicon/`. Add those words (one line each: base form, part of speech, level, English meaning, gender, plural, other forms).
3. Run `python3 tools/build_books.py`, raise `version` for that book in `books/index.json`, commit and push.

## Privacy

All progress stays on the phone (IndexedDB). Books in the `books` folder are public if the repository is public. Nothing is sent to a server.

## Install on iPhone

1. Open the site in Safari.
2. Tap Share, then Add to Home Screen, then Add.
3. Open the app from the new icon and load the book file there. Safari and the installed app keep separate storage.

## Files

| File | Purpose |
| --- | --- |
| index.html | page shell |
| app.js | the app |
| db.js | storage on the phone (IndexedDB) |
| styles.css | design |
| sw.js | offline cache (service worker) |
| books/index.json | list of books on the shelf |
| manifest.webmanifest, icon-*.png | Home Screen app name and icons |

## Update

Change `VERSION` at the top of `sw.js` (and `APP_VERSION` in `app.js`), then upload the changed files. Without a new `VERSION` the phone keeps using the old files. The app shows "A new version of the app is ready" and reloads after you tap Reload. Progress on the phone is kept.
