# Spaced Cards

A small spaced-repetition app in the style of Quizlet's **Learn** mode. It is a static site (no build, no server), so it runs on GitHub Pages. It is designed for phones first and can be installed to the home screen (works offline).

## Using it

1. **Export from Quizlet**: open a set → `⋯` → *Export*. Keep the defaults (Tab between term and definition, new line between cards) and copy the text, or save it as a `.txt` file.
2. In the app tap **+ Import** and either choose the file or paste the text. A preview shows the cards it found. Pick other separators if you used custom ones.
3. Tap **Learn** on a set. Cards that are due (plus up to 15 new ones) come in rounds of 7: first multiple choice, then typing the answer. A wrong typed answer has to be retyped correctly before you can continue. Misses come back until you get them right. Finished cards are scheduled for later days (1 → 3 → longer, SM-2 style). **Practice all** studies everything without changing the schedule.

Each set on the library screen shows how much of it is learned. Tapping a set opens its page with **Flashcards**, **Learn** (or **Resume**), **Practice all**, **Cards**, **Starred** and **Settings** tiles, plus **Edit** and **Delete** buttons underneath.

"Answer with" on the library screen picks whether you are asked for the definition, the term, or both.

### Flashcards

Tap **Flashcards** on the set page (or in the card list, where it follows the All/Starred filter). Tap the card to flip it, then choose **Knew it** or **Didn't know**. At the end you can review just the cards you missed. On a keyboard: Space flips, → knew it, ← didn't know. Flashcards don't change the review schedule.

### Images

Quizlet's export has no images, so add them yourself in one of these ways:

- **Zip**: put a text file and the image files in one `.zip`. In the text file use the image file name as a side of a card (`Circle<TAB>circle.svg`) or inside text with `[img:circle.svg]`.
- **Loose files**: in the file picker, select the text file *and* the image files together.
- **URL**: a side that is only an image URL (`https://…/cat.jpg`) or `[img:https://…]` is shown as an image (needs internet).

Try `sample/sample.txt` (text only) and `sample/shapes.zip` (with images).

### Set settings and resuming

Tap **Settings** on the set page to choose its learn mode: multiple choice then written (default), multiple choice only, or written only. It applies to the next session.

While studying, tap the pencil on the question to fix the current card's term or definition.

Progress is saved after every answer. If you close a session or the app, the set shows **Resume** (with progress) and **Start over** next time.

### Viewing and starring cards

Tap **Cards** on the set page to see all cards with their definitions and images. Tap the star to star a card, switch between **All** and **Starred**, and tap **Learn starred** to study only the starred cards. The **Starred** tile opens the list already filtered. You can also star the current card while studying. Starred sessions don't change the review schedule.

### Editing a set

Tap **Edit** on the set page to rename it, change card text, add or delete cards, and add or replace images. Learning progress of existing cards is kept.

### Your data

Everything is stored in your browser (IndexedDB) on that device. Use **Save backup** / **Restore backup** on the library screen to move to another device or to keep a copy. Clearing site data deletes your sets.

## Deploy to GitHub Pages

1. Create a GitHub repository and push these files to `main`.
2. Repo → *Settings* → *Pages* → *Deploy from a branch* → `main` / `(root)`.
3. Open `https://<your-user>.github.io/<repo>/` on your phone and use *Add to Home Screen*.

All paths are relative, so it works under a repo sub-path.

## Run locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. (The service worker/offline install needs HTTPS or localhost.) After changing app files, bump `CACHE` in `sw.js`.
