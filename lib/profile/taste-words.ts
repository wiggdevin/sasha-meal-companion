/**
 * The words the taste safety check (lib/profile/taste-safety.ts) can read (Phase 18 D9 item 3):
 * plain function words, like and dislike verbs, how food eats, cuisines, dishes and food names
 * (every word of every universe family name; tests/profile/taste-safety.test.ts keeps that true).
 * A word outside this list keeps the text local as `unsure`. Vague nouns ("thing", "stuff") are left
 * out on purpose: "I have a dairy thing" is how people name a sensitivity without naming it. Health, symptom and rule words are
 * never here: the check refuses them before it reads this list, and the test pins that none of the
 * words below matches a rule or symptom pattern on its own.
 *
 * Pure data. No I/O.
 */
const FUNCTION_WORDS = `a an the i i'm im i've ive i'd me my mine myself we we're our us you your it it's its
this that these those they them their there here is am are was were be been being do does did have has
had having and or but so as at by for from in into of on onto to with about than then too very really
quite pretty super so much more most less least lot lots all any some every each both most kind sort
type types bit little just also even still mostly usually always often sometimes generally pretty
over under up out off down like such what which who how when if though although while because since
one ones way ways`;

const VERBS = `like likes liked love loves loved adore adores enjoy enjoys enjoyed prefer prefers preferred
hate hates hated dislike dislikes disliked detest despise loathe stand crave craves craving cravings
want wants eat eats eating ate try tried grew grow growing raised raise up order ordered cook cooks
cooking cooked make bake baked go goes going went get gets find finds think tastes taste tasted smell
smells seem seems mind fan fans obsessed addicted into big huge favorite favourite favorites favourites
fave faves go-to staple staples comfort weakness picky fussy adventurous open choose pick`;

const DESCRIPTORS = `food foods texture textures flavor flavors flavour flavours taste tastes smell smells
dish dishes meal meals snack snacks cuisine cuisines kind style home homemade home-cooked cooking
soft mushy slimy squishy gooey runny watery soggy wet spongy jelly jello jiggly gelatinous rubbery
chewy tough stringy gristly fatty greasy oily rich heavy light fresh crisp crispy crunchy crumbly dry
creamy smooth thick thin lumpy grainy gritty sticky spicy hot mild heat fiery peppery bland plain
salty savory savoury sweet sour tangy tart bitter umami smoky smoked charred grilled roasted fried
deep-fried baked steamed boiled raw cooked rare well-done pickled fermented cured spiced seasoned
garlicky herby herbal earthy nutty fruity zesty citrusy fishy gamey pungent strong funky stinky
overpowering subtle delicate intense rich buttery cheesy saucy chunky bite bites crunch strong-smelling
organ organs offal meaty veggie veggies vegetable vegetables fruit fruits greens leafy seafood fish
shellfish meat meats poultry grain grains bean legumes legume nut seed dairy cheese carbs carb
starchy starch sauce sauces dressing soup soups stew stews salad salads sandwich sandwiches dessert
desserts breakfast lunch dinner brunch side sides`;

const CUISINES = `american mexican tex-mex texmex latin latino latin-american south southern cajun creole
italian mediterranean middle eastern greek turkish lebanese persian israeli moroccan indian south-asian
pakistani bangladeshi sri lankan nepali chinese cantonese szechuan sichuan hunan japanese korean
southeast asian thai vietnamese filipino indonesian malaysian caribbean jamaican cuban puerto rican
dominican haitian african ethiopian nigerian west east north european french spanish german polish
russian british irish portuguese scandinavian nordic hungarian ukrainian brazilian peruvian
argentinian colombian salvadoran soul bbq barbecue barbeque fusion street`;

const DISHES = `pizza pasta burger burgers taco tacos burrito burritos enchilada enchiladas quesadilla
quesadillas nachos fajitas tamales salsa guacamole chili curry curries sushi sashimi ramen pho noodle
noodles dumpling dumplings stir-fry stir fry fried-rice kimchi bibimbap bulgogi pad dim sum bao
tempura teriyaki falafel shawarma kebab kebabs gyro gyros hummus pita biryani tikka masala dal daal
naan samosa samosas paella tapas risotto lasagna lasagne gnocchi ravioli pesto mac casserole meatloaf
meatballs wings ribs brisket steak steaks roast chops fries chips wrap wraps bowl bowls smoothie
smoothies oatmeal porridge cereal toast bagel bagels pancakes waffles omelet omelette eggs scrambled
poached jerk plantains rice beans tortilla tortillas cornbread biscuits gravy grits gumbo jambalaya
po'boy fish-and-chips pierogi borscht goulash schnitzel crepes croissant baguette couscous tagine
injera jollof fufu dosa idli chutney raita pickles olives anchovy anchovies sardine liver tripe
pate tofu tempeh seitan mushroom mushrooms cilantro coriander`;

/** Every word of every universe family name (baseFoodName form), as of universe 1.0.0. */
const FAMILY_WORDS = `acorn adzuki albacore almond almonds amaranth anchovies and apple applesauce apricot
apricots artichoke arugula asian asparagus avocado bamboo banana barley basil basmati bass bean beans beef
beets bell bison bitter black black-eyed blackberries blue blueberries bok brazil bread breadfruit breast
brie brisket broccoli brown brussels buckwheat bulgur bun butter butternut cabbage cake callaloo canned
canola cantaloupe carrot cashew cashews catfish cauliflower celeriac celery chapati chard chayote cheddar
cheese cherries chestnuts chia chicken chickpeas chinese chop choy chuck cilantro clams clementine cob
coconut cod collard corn cottage couscous crab cranberries cream cucumber cutlet daikon dal dandelion
dates dinner dried drumstick duck edamame egg eggplant english farro fava fennel feta figs filet flank
flax flour fresco gai garlic ghee goat gouda gourd gram grape grapefruit grapes greek green greens grits
groats ground guava haddock half halibut hamburger hazelnuts heavy hemp herring hominy honeydew hummus
iceberg jackfruit jalapeno jasmine jicama kale kasha kidney kimchi kiwi kohlrabi lamb lan lard leaves
leeks leg lemon lemongrass lentils lettuce lime liver lobster lotus lychee macadamia mackerel mahi mango
mignon milk millet mint mixed moong mozzarella muffin multigrain mung mushroom mushrooms mussels naan
napa natto navy nectarine new noodles nopales nuts oatmeal oats octopus of oil okra olive olives on
onion orange oysters papaya parmesan parsley parsnips pasta peach peaches peanut peanuts pear peas pecans
pepper pigeon pine pineapple pinto pistachios pita plantain plum pomegranate popcorn pork portobello
potato provolone prunes pulled pumpkin queso quinoa radish raisins raspberries red refried ribeye ribs
rice ricotta roast roll rolled romaine root roti rutabaga rye salmon sardines sauerkraut scallops sea
seaweed seed seeds sesame shiitake shoots short shoulder shrimp sirloin skim skin skirt snow soba sour
sourdough soybean spaghetti spelt spinach split sprouts squash steak strawberries string strip sunflower
sushi sweet swiss swordfish tahini tamarind taro teff tempeh tenderloin the thigh tilapia tofu tomatillos
tomato toor tortilla trout tuna turkey turnips urad veal wakame walnuts water watercress watermelon wheat
white whole wild wing with yam yardlong yellow yogurt york zucchini`;

const EXTRA_FOODS = `potatoes tomatoes onions carrots peppers cucumbers apples bananas oranges lemons limes
berries melon melons coconut cashew pistachio walnut pecan beets radishes turnip parsnip eggplants
aubergine courgette chilli chilies chiles jalapenos sprout cheeses yoghurt bacon ham sausage sausages
salami pepperoni hotdog hotdogs jerky shrimp prawn prawns calamari squid clam mussel oyster scallop
lobster crab caviar roe eel duck lamb mutton venison goat veal turkey chicken beef pork fish tuna
cod salmon trout halibut tilapia sardines mackerel herring anchovy chocolate candy candies sweets cake
cakes cookies cookie pie pies ice-cream icecream cream custard pudding tea juice soda stew stews soup soups salad salads sandwich sandwiches`;

const SPLIT = /\s+/;

export const TASTE_WORDS: ReadonlySet<string> = new Set(
  [FUNCTION_WORDS, VERBS, DESCRIPTORS, CUISINES, DISHES, FAMILY_WORDS, EXTRA_FOODS]
    .flatMap((list) => list.split(SPLIT)).filter((word) => word.length > 0),
);

/** Generic words in the food lists that are not food names on their own. */
const NOT_FOOD = new Set(["and", "of", "the", "with", "on", "new", "half", "whole", "mixed", "dinner", "short", "leg"]);

/**
 * Food names only (dishes, every universe family word, common foods): the argument a coach command
 * may carry ("add cheese to my avoid list"). lib/profile/coach-commands.ts.
 */
export const FOOD_WORDS: ReadonlySet<string> = new Set(
  [DISHES, FAMILY_WORDS, EXTRA_FOODS].flatMap((list) => list.split(SPLIT))
    .filter((word) => word.length > 0 && !NOT_FOOD.has(word)),
);
