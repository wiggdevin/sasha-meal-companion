# Chat-first Landing 1 — iPhone Acceptance Checklist

Devin does this pass himself, on his own iPhone, after landing 1 is live in production.
PRD: `docs/plans/2026-09-19-chat-first.md`, task A7, criterion C8.

Before you start:
- Open the app on your iPhone, not a simulator.
- Sign in with your normal account.
- Make sure you have at least one food you can eat and one food on your Avoid list.

For each step: do the action, then check the result against "Expect". Mark it OK or NOT OK.
Take the listed screenshot after each group.

## a. FAB opens the full-screen coach

1. On the Today tab, tap the FAB (the round chat button).
   Expect: the coach opens full screen. No tab bar shows at the bottom.
2. Tap Back.
   Expect: you return to the Today tab.
3. On the Foods tab, tap the FAB.
   Expect: same as step 1.
4. Tap Back.
   Expect: you return to the Foods tab.
5. On the Settings tab, tap the FAB.
   Expect: same as step 1.
6. Tap Back.
   Expect: you return to the Settings tab.

## b. iMessage-style chat shell

7. Open the coach when you already have message history.
   Expect: the chat opens at the newest message, not at the top.
8. Look at the bottom of the screen.
   Expect: the text box (composer) is always visible.
9. Tap the text box to open the keyboard.
   Expect: the keyboard opens. The text box stays visible above the keyboard, not covered.
10. Scroll up to load older messages.
    Expect: older messages load in. The screen does not jump to a new position on its own.
11. While scrolled up, wait for (or cause) a new reply to arrive.
    Expect: a small "↓ New message" pill appears. The screen does not jump to the bottom.
12. Tap the "↓ New message" pill.
    Expect: the screen scrolls to the bottom. The newest message is visible.

## c. Composer toolbar

13. Look at the row of icons above the text box.
    Expect: three icons, in this order: Scan, then Camera, then Weigh in. They sit flush
    against the right edge.
14. Tap each of the three icons.
    Expect: each icon is easy to tap with a thumb. Each tap target is at least 44 by 44 points.
15. Look at the microphone icon and the Send button.
    Expect: the microphone sits to the left of Send.

## d. Scan a barcode

16. Tap Scan. Scan the barcode of a food you can eat.
    Expect: a card appears in the chat. It shows the product name and a grams field you can
    edit.
17. Change the grams value on the card.
    Expect: the card shows your new value.
18. Tap "Log it".
    Expect: the app logs the food. The card shows it is logged.
19. Tap "Undo".
    Expect: the app removes the logged entry.
20. Scan the barcode of a food on your Avoid list.
    Expect: the card says the food is blocked (or flagged).
21. Tap "Log it" on that blocked card.
    Expect: the app still logs the food. The entry carries a mark showing it was on your
    Avoid list.

## e. Camera capture

22. Tap Camera.
    Expect: the shutter screen opens directly in plate mode (not label mode).
23. Take a photo of a plate of food.
    Expect: a card appears in the chat, listing the food items the app found.
24. On that card, tap "This was a nutrition label" one time.
    Expect: the app reads the same photo again, this time as a label. It does this once,
    not on a loop.

## f. Weigh in

25. Tap Weigh in.
    Expect: an inline field appears, already set to your weight unit (for example, lb or
    kg).
26. Enter a weight and send it.
    Expect: the chat shows the message "I weigh <n> <unit> this morning". The coach logs
    the weight.

## g. Open the /scan link directly

27. Open the `/scan` link directly (type it in Safari, or open a saved link/bookmark).
    Expect: the app opens the coach chat with the scanner already open. The scanner opens
    one time, not more than once.

## h. Rotate and background the app

28. Rotate your phone from portrait to landscape and back.
    Expect: the text box stays at the bottom of the screen. The chat still shows the
    newest message.
29. Press the Home button (or swipe up) to background the app. Wait a few seconds. Reopen
    the app.
    Expect: the text box is still at the bottom. The chat still shows the newest message.

## Screenshots to attach

Save each file under `docs/screenshots/chat-first/`, using these names:

- `a-fab-full-screen-coach.png` — the FAB and the full-screen coach it opens, with no tab
  bar.
- `b-imessage-shell.png` — the chat at the newest message, with the "↓ New message" pill
  visible.
- `c-toolbar.png` — the Scan, Camera, Weigh in row above the text box.
- `d-barcode-log-draft.png` — the log-draft card from a barcode scan, and the blocked card
  from an Avoid-list scan.
- `e-camera-plate-card.png` — the card from a plate photo.
- `f-weigh-in.png` — the inline weigh-in field and the resulting chat message.
- `g-scan-link.png` — the chat right after opening the `/scan` link.
- `h-rotate-background.png` — the chat after rotating and after backgrounding the app.
