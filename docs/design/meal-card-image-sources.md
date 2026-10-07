# After Dark card imagery

These local images provide atmosphere, not a photograph of a user's actual meal. The card labels
stock imagery as illustrative. `lib/today/meal-art.ts` selects a photo only when the current
ingredient names support its subject; otherwise the hero keeps the neutral ground artwork.

The images were downloaded from free Unsplash photo pages under the [Unsplash License](https://unsplash.com/license),
which permits use in this app. The images are not a food database and never supply ingredient or
nutrition facts.

| Local asset | Source |
| --- | --- |
| `public/meal-art/chicken.webp` | [Grilled chicken by Emmanuel M](https://unsplash.com/photos/grilled-chicken-with-sauce-and-vegetables-on-plate-fslrfR2fp-A) |
| `public/meal-art/eggs-rice.webp` | [Rice and eggs by Arnaldo Motta](https://unsplash.com/photos/bowl-of-rice-and-eggs-oROd_EB2vD8) |
| `public/meal-art/scallops.webp` | [Scallops by Geoffrey Moffett](https://unsplash.com/photos/seared-scallops-are-elegantly-presented-on-a-shell-HnSt26SdiaQ) |
| `public/meal-art/shake.webp` | [Banana milkshake by Elena Leya](https://unsplash.com/photos/a-smoothie-in-a-glass-with-a-straw-O39Vx5yPaD4) |
| `public/meal-art/yogurt.webp` | [Blueberries and yogurt by Serghey Savchuk](https://unsplash.com/photos/blueberries-and-yogurt-in-a-jar-mVATt65Q4Mc) |

## Sprout, the glass-well pet

Sprout is an original character made for Sasha on 2026-10-06 (owner's brief: a high-definition
fuzzy pet in the Day card's glass well). The four mood renders were generated with GPT Image 2 on the
owner's Higgsfield plan, the moods from the first render as a reference so the character stays the
same, then cut out locally with rembg (BiRefNet) and cropped to one shared frame, so a mood change
never shifts the pet. It is not modelled on any existing character.

| Local asset | Mood (lib/today/pet-mood.ts) |
| --- | --- |
| `public/pet/sprout-content.webp` | content: doing fine |
| `public/pet/sprout-joyful.webp` | joyful: on pace for the hour |
| `public/pet/sprout-sleepy.webp` | sleepy: night, 21:00–06:00 |
| `public/pet/sprout-droopy.webp` | droopy: the day has fallen behind |

Hero-size art (768 px, 2026-10-07, for onboarding v2's guide through `SproutFigure`): the same four
renders, cut again with rembg (BiRefNet) from their 2k Higgsfield masters, plus a fifth pose made the
same way (GPT Image 2 on the owner's Higgsfield plan, the content render as the reference): waving
hello. Every hero pose (eight with the onboarding three below) shares one square frame, so a pose change never moves the pet. Rights: generated output
from the owner's paid Higgsfield plan, of an original character made for Sasha (the same basis as the
four originals above). Higgsfield's Terms of Use §4.4 claim no ownership of outputs and do not
restrict their commercial use; paid plans download without watermarks (Higgsfield help centre, "Who
owns my generations and can I use them commercially?",
https://higgsfield.ai/creator-hub/help-center/account/who-owns-my-generations-and-can-i-use-them-commercially,
read 2026-10-07).

| Local asset | Pose |
| --- | --- |
| `public/pet/hero/sprout-content.webp` | content |
| `public/pet/hero/sprout-joyful.webp` | joyful |
| `public/pet/hero/sprout-sleepy.webp` | sleepy |
| `public/pet/hero/sprout-droopy.webp` | droopy |
| `public/pet/hero/sprout-wave.webp` | wave: a first hello |
| `public/pet/hero/sprout-listening.webp` | listening: leaning in, a paw cupped by its head, while the user speaks |
| `public/pet/hero/sprout-thinking.webp` | thinking: a paw at its chin, while Sasha reads what was said |
| `public/pet/hero/sprout-pointing.webp` | pointing: an arm out to the viewer's right, at a choice or an empty slot |

The three onboarding poses (2026-10-07) were made the same way as the wave, from the content render,
and placed on its footing: the same height and feet line, centred on the body, in the shared frame.

## Sprout's pond (2026-10-07)

The pond scene in the open well (`components/today/scene/`). Same rights basis as the hero art above:
generated output from the owner's paid Higgsfield plan (GPT Image 2), of an original character and
original scenery made for this app. Sprout's poses were made from the content render as the
reference, the rock and the catches from the fishing render; cut out locally with rembg (BiRefNet),
the rod kept by a colour key, and every pose aligned to the rock so a pose change never moves the pet.

| Local asset | What |
| --- | --- |
| `public/pet/scene/pond-sky.webp` | The backdrop: petrol evening sky, mossy far shore, the lake bed (700 × 840) |
| `public/pet/scene/cloud-1.webp`, `cloud-2.webp` | Two felt clouds that drift |
| `public/pet/scene/rock.webp` | The mossy rock Sprout sits on, its own layer |
| `public/pet/scene/sprout-fishing.webp` | Seated in profile, fishing with a stick |
| `public/pet/scene/sprout-cast.webp` | Winding up a cast |
| `public/pet/scene/sprout-catch.webp` | A catch: rod up, delighted |
| `public/pet/scene/sprout-sulk.webp` | Facing away: the day is behind |
| `public/pet/scene/sprout-lookback.webp` | Looking back over its shoulder in tears |
| `public/pet/scene/sprout-annoyed.webp` | Arms crossed: poked too much |
| `public/pet/scene/catch-fish.webp`, `catch-tip.webp`, `catch-token.webp` | What Sprout can catch |
| `public/pet/scene/sprout-rockthrow-windup.webp`, `sprout-rockthrow-release.webp` | A moment: skipping a pebble |
| `public/pet/scene/sprout-dance-1.webp`, `sprout-dance-2.webp` | A moment: a little dance on the rock |
| `public/pet/scene/sprout-workout-lift.webp`, `sprout-workout-flex.webp` | A moment: dumbbells and a white headband |
| `public/pet/scene/sprout-tummy-round.webp`, `sprout-tummy-suck.webp` | A moment, only on a double tap: a round tummy, sucked in |
| `public/pet/scene/sprout-swim.webp` | A moment: a swim across the lake |
| `public/pet/scene/sprout-doze.webp` | Night: dozing on the rock, rod resting |
| `public/pet/scene/sprout-stick-1.webp`, `sprout-stick-2.webp` | A moment: doodling in the moss with a twig (the generated rock removed by colour, the twig kept) |

## The water view (2026-10-07)

The open well's water (`components/today/island/WaterExtras.tsx`). Same rights basis: generated
output from the owner's paid Higgsfield plan (GPT Image 2), Sprout from the hero art as the reference,
the droppers with the bucket art as the style reference; cut out locally with rembg (BiRefNet). The
plum dropper is the generated one mirrored, so each points into the water from its own wall.

| Local asset | What |
| --- | --- |
| `public/pet/water/sprout-bucket-hold.webp`, `sprout-bucket-pour.webp` | Sprout with a wooden bucket, held and tipped |
| `public/pet/water/dropper-orange.webp`, `dropper-plum.webp` | A glass ink dropper for each ink (480 × 101) |

## Sprout's awards (2026-10-07)

The award player (`components/today/care/`). Same rights basis: generated output from the owner's paid
Higgsfield plan (GPT Image 2), original art made for this app, cut out locally with rembg (BiRefNet).

| Local asset | What |
| --- | --- |
| `public/pet/awards/award-{stone,earth,grass,wood,metal,neon}.webp` | Blank award tokens in six materials, a leaf emblem |
| `public/pet/awards/sprout-workout-lift.webp`, `sprout-workout-flex.webp` | The buff workout: dumbbells, then the red-faced flex |
| `public/pet/night/bench.webp` | The night scene: one lamp over a bench, a crescent moon (700 × 840) |
| `public/pet/night/bat-walk.webp`, `bat-reveal.webp` | An original plush bat, walking and with wings open |

## Sprout's shop (2026-10-07)

The shop and wardrobe (`components/today/care/shop/`). Same rights basis: generated output from the
owner's paid Higgsfield plan (GPT Image 2), each item on its own with Sprout's hero art as the style
reference; cut out locally with rembg (BiRefNet). The round glasses' clear lenses were made faint
glass after the cut. Every item is a layer placed on Sprout's content pose, never a re-drawn Sprout.

| Local asset | What |
| --- | --- |
| `public/pet/shop/knitted-hat.webp`, `bucket-hat.webp` | Head: a cream knitted hat with a pom-pom, an olive bucket hat |
| `public/pet/shop/glasses.webp`, `sunglasses.webp` | Eyes: round gold reading glasses, round dark sunglasses |
| `public/pet/shop/mitten.webp` | Hands: one red knitted mitten (the other hand mirrors it) |
| `public/pet/shop/shorts.webp` | Legs: denim shorts with a belt, clipped to Sprout's outline |
| `public/pet/shop/leaf-pin.webp` | Pin: a green enamel leaf pin |
| `public/pet/shop/sprout-leaf.webp` | Sprout's own leaf, cut from the content pose (768 px frame), drawn over a hat |

## Sprout's care scenes (2026-10-07)

Care scenes from the shop (`components/today/care/CareScenePlayer.tsx`). Same rights basis: generated
output from the owner's paid Higgsfield plan (GPT Image 2) with Sprout's hero art as the reference; the
white background keyed out locally (rembg dropped the wooden table), both frames in one 720 × 560 frame.

| Local asset | What |
| --- | --- |
| `public/pet/care/massage-1.webp` | Massage: Sprout face down on a tiny spa table, warm stones on its back |
| `public/pet/care/massage-2.webp` | Massage, after: Sprout sitting up on the table, glowing |
