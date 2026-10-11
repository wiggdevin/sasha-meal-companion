#!/usr/bin/env python3
"""
Build lib/food-db.json from USDA FoodData Central SR Legacy (2018-04 CSV).

Source: https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
Extracted to ~/Backups/usda/sr_legacy/ (not committed).

Each curated entry is (friendly name, category, [keywords]). The script picks
the SHORTEST SR description containing every keyword (case-insensitive), so
"chicken breast roasted" resolves to the plain roasted breast, not a
marinated-fried-with-skin variant. Every match is printed for review; a miss
is a hard failure so the list never silently shrinks.

Values are per 100 g (kcal, protein, carbs, fat, fibre) plus household
portions with gram weights from food_portion.csv. Each SR row carries its
FoodData Central id (`fdcId`), the `source_id` of its `fdc_sr_legacy`
catalog food, which the Phase 18 universe manifest pins, and its SR food
group (`srCategory`), the catalog revision's `category`.

Usage: python3 scripts/build-food-db.py > lib/food-db.json
"""

import csv
import json
import os
import re
import sys
from collections import defaultdict

SR = os.path.expanduser("~/Backups/usda/sr_legacy")
NUTRIENTS = {"1008": "kcal", "1003": "protein", "1005": "carbs", "1004": "fat", "1079": "fiber"}

# (friendly name, category, keywords) — keywords must all appear in the SR description.
CURATED = [
    # ---- Poultry
    ("Chicken breast, roasted", "protein", ["chicken", "broilers", "breast", "meat only", "roasted"]),
    ("Chicken thigh, roasted", "protein", ["chicken", "broilers", "thigh", "meat only", "roasted"]),
    ("Chicken thigh with skin, roasted", "protein", ["chicken", "broilers", "thigh", "meat and skin", "roasted"]),
    ("Chicken drumstick, roasted", "protein", ["chicken", "broilers", "drumstick", "meat only", "roasted"]),
    ("Chicken wing, roasted", "protein", ["chicken", "broilers", "wing", "meat and skin", "roasted"]),
    ("Rotisserie chicken, breast", "protein", ["chicken", "broiler", "rotisserie", "breast", "meat only"]),
    ("Ground chicken, cooked", "protein", ["chicken", "ground", "crumbles", "cooked"]),
    ("Turkey breast, roasted", "protein", ["turkey", "breast", "meat only", "roasted"]),
    ("Ground turkey, cooked", "protein", ["turkey", "ground", "cooked"]),
    ("Turkey deli slices", "protein", ["turkey", "breast", "sliced", "prepackaged"]),
    ("Duck breast, roasted", "protein", ["duck", "domesticated", "meat only", "roasted"]),
    # ---- Beef
    ("Ground beef 90/10, cooked", "protein", ["beef", "ground", "90% lean", "patty", "cooked", "broiled"]),
    ("Ground beef 85/15, cooked", "protein", ["beef", "ground", "85% lean", "patty", "cooked", "broiled"]),
    ("Ground beef 80/20, cooked", "protein", ["beef", "ground", "80% lean", "patty", "cooked", "broiled"]),
    ("Sirloin steak, broiled", "protein", ["beef", "top sirloin", "separable lean only", "trimmed to 0", "broiled"]),
    ("Ribeye steak, grilled", "protein", ["beef", "rib eye", "separable lean only", "grilled"]),
    ("Filet mignon, broiled", "protein", ["beef", "tenderloin", "steak", "separable lean only", "broiled"]),
    ("New York strip, broiled", "protein", ["beef", "top loin", "steak", "separable lean only", "broiled"]),
    ("Flank steak, broiled", "protein", ["beef", "flank", "separable lean only", "broiled"]),
    ("Skirt steak, broiled", "protein", ["beef", "skirt", "separable lean only", "broiled"]),
    ("Chuck roast, braised", "protein", ["beef", "chuck", "pot roast", "separable lean only", "braised"]),
    ("Brisket, braised", "protein", ["beef", "brisket", "flat half", "separable lean only", "braised"]),
    ("Beef short ribs, braised", "protein", ["beef", "short ribs", "separable lean only", "braised"]),
    ("Beef jerky", "protein", ["beef", "jerky"]),
    ("Beef liver, pan-fried", "protein", ["beef", "liver", "pan-fried"]),
    ("Bison, cooked", "protein", ["bison", "ground", "cooked"]),
    ("Veal cutlet, cooked", "protein", ["veal", "cutlet", "cooked"]),
    # ---- Pork
    ("Pork tenderloin, roasted", "protein", ["pork", "tenderloin", "separable lean only", "roasted"]),
    ("Pork chop, broiled", "protein", ["pork", "loin", "center loin", "chops", "separable lean only", "broiled"]),
    ("Pork shoulder, roasted", "protein", ["pork", "shoulder", "blade", "separable lean only", "roasted"]),
    ("Pulled pork", "protein", ["pork", "fresh", "shoulder", "arm picnic", "separable lean only", "roasted"]),
    ("Bacon, cooked", "protein", ["pork", "cured", "bacon", "cooked", "pan-fried"]),
    ("Canadian bacon", "protein", ["canadian bacon", "unprepared"]),
    ("Ham, sliced", "protein", ["ham", "sliced", "regular"]),
    ("Pork sausage, cooked", "protein", ["sausage", "pork", "fresh", "cooked"]),
    ("Italian sausage, cooked", "protein", ["sausage", "italian", "pork", "cooked"]),
    ("Chorizo", "protein", ["sausage", "pork", "chorizo"]),
    ("Pepperoni", "protein", ["pepperoni", "beef and pork", "sliced"]),
    ("Salami", "protein", ["salami", "dry or hard", "pork"]),
    ("Hot dog, beef", "protein", ["frankfurter", "beef", "unheated"]),
    ("Bratwurst", "protein", ["bratwurst", "pork", "cooked"]),
    ("Pork ribs, roasted", "protein", ["pork", "spareribs", "separable lean and fat", "roasted"]),
    ("Lamb chop, broiled", "protein", ["lamb", "loin", "separable lean only", "broiled"]),
    ("Ground lamb, cooked", "protein", ["lamb", "ground", "cooked", "broiled"]),
    ("Leg of lamb, roasted", "protein", ["lamb", "leg", "whole", "separable lean only", "roasted"]),
    # ---- Fish & seafood
    ("Salmon, Atlantic farmed, cooked", "protein", ["salmon", "atlantic", "farmed", "cooked"]),
    ("Salmon, wild sockeye, cooked", "protein", ["salmon", "sockeye", "cooked"]),
    ("Smoked salmon", "protein", ["salmon", "chinook", "smoked"]),
    ("Canned salmon, pink", "protein", ["salmon", "pink", "canned", "drained solids"]),
    ("Tuna, yellowfin, cooked", "protein", ["tuna", "yellowfin", "cooked"]),
    ("Tuna, canned in water, light", "protein", ["tuna", "light", "canned in water", "drained solids"]),
    ("Tuna, canned in oil, light", "protein", ["tuna", "light", "canned in oil", "drained solids"]),
    ("Albacore tuna, canned in water", "protein", ["tuna", "white", "canned in water", "drained solids"]),
    ("Cod, cooked", "protein", ["cod", "atlantic", "cooked", "dry heat"]),
    ("Halibut, cooked", "protein", ["halibut", "atlantic and pacific", "cooked", "dry heat"]),
    ("Tilapia, cooked", "protein", ["tilapia", "cooked", "dry heat"]),
    ("Mahi mahi, cooked", "protein", ["mahimahi", "cooked", "dry heat"]),
    ("Trout, cooked", "protein", ["trout", "rainbow", "farmed", "cooked", "dry heat"]),
    ("Sea bass, cooked", "protein", ["sea bass", "mixed species", "cooked", "dry heat"]),
    ("Swordfish, cooked", "protein", ["swordfish", "cooked", "dry heat"]),
    ("Haddock, cooked", "protein", ["haddock", "cooked", "dry heat"]),
    ("Catfish, cooked", "protein", ["catfish", "channel", "farmed", "cooked", "dry heat"]),
    ("Sardines, canned in oil", "protein", ["sardine", "atlantic", "canned in oil", "drained solids"]),
    ("Anchovies, canned", "protein", ["anchovy", "canned in oil", "drained solids"]),
    ("Mackerel, cooked", "protein", ["mackerel", "atlantic", "cooked", "dry heat"]),
    ("Shrimp, cooked", "protein", ["shrimp", "mixed species", "cooked", "moist heat"]),
    ("Scallops, raw", "protein", ["scallop", "mixed species", "raw"]),
    ("Crab, cooked", "protein", ["crab", "alaska king", "cooked", "moist heat"]),
    ("Lobster, cooked", "protein", ["lobster", "northern", "cooked", "moist heat"]),
    ("Mussels, cooked", "protein", ["mussel", "blue", "cooked", "moist heat"]),
    ("Clams, cooked", "protein", ["clam", "mixed species", "cooked", "moist heat"]),
    ("Oysters, raw", "protein", ["oyster", "eastern", "wild", "raw"]),
    ("Squid, fried", "protein", ["squid", "mixed species", "cooked", "fried"]),
    ("Fish sticks", "protein", ["fish sticks", "frozen", "prepared"]),
    ("Crab cake", "protein", ["crab", "blue", "crab cakes", "home recipe"]),
    # ---- Eggs & dairy
    ("Egg, whole, large", "protein", ["egg", "whole", "raw", "fresh"]),
    ("Egg, hard-boiled", "protein", ["egg", "whole", "cooked", "hard-boiled"]),
    ("Egg, scrambled", "protein", ["egg", "whole", "cooked", "scrambled"]),
    ("Egg, fried", "protein", ["egg", "whole", "cooked", "fried"]),
    ("Egg white", "protein", ["egg", "white", "raw", "fresh"]),
    ("Egg yolk", "protein", ["egg", "yolk", "raw", "fresh"]),
    ("Whole milk", "dairy", ["milk", "whole", "3.25% milkfat", "with added vitamin d"]),
    ("2% milk", "dairy", ["milk", "reduced fat", "2% milkfat", "with added vitamin a and vitamin d"]),
    ("Skim milk", "dairy", ["milk", "nonfat", "fluid", "with added vitamin a and vitamin d"]),
    ("Chocolate milk", "dairy", ["milk", "chocolate", "fluid", "commercial", "whole"]),
    ("Greek yogurt, plain nonfat", "dairy", ["yogurt", "greek", "plain", "nonfat"]),
    ("Greek yogurt, plain whole milk", "dairy", ["yogurt", "greek", "plain", "whole milk"]),
    ("Yogurt, plain whole milk", "dairy", ["yogurt", "plain", "whole milk"]),
    ("Yogurt, vanilla low-fat", "dairy", ["yogurt", "vanilla", "low fat", "fortified"]),
    ("Cottage cheese, 2%", "dairy", ["cheese", "cottage", "lowfat", "2% milkfat"]),
    ("Cheddar cheese", "dairy", ["cheese", "cheddar"]),
    ("Mozzarella cheese", "dairy", ["cheese", "mozzarella", "whole milk"]),
    ("Parmesan cheese", "dairy", ["cheese", "parmesan", "grated"]),
    ("Swiss cheese", "dairy", ["cheese", "swiss"]),
    ("Feta cheese", "dairy", ["cheese", "feta"]),
    ("Cream cheese", "dairy", ["cheese", "cream"]),
    ("American cheese", "dairy", ["cheese", "pasteurized process", "american", "fortified"]),
    ("Goat cheese", "dairy", ["cheese", "goat", "soft"]),
    ("Brie", "dairy", ["cheese", "brie"]),
    ("Blue cheese", "dairy", ["cheese", "blue"]),
    ("Provolone", "dairy", ["cheese", "provolone"]),
    ("Ricotta, whole milk", "dairy", ["cheese", "ricotta", "whole milk"]),
    ("String cheese", "dairy", ["cheese", "mozzarella", "low moisture", "part-skim"]),
    ("Butter", "fat", ["butter", "salted"]),
    ("Ghee", "fat", ["butter oil", "anhydrous"]),
    ("Heavy cream", "dairy", ["cream", "fluid", "heavy whipping"]),
    ("Half and half", "dairy", ["cream", "fluid", "half and half"]),
    ("Sour cream", "dairy", ["cream", "sour", "cultured"]),
    ("Whipped cream", "dairy", ["cream", "whipped", "cream topping", "pressurized"]),
    ("Ice cream, vanilla", "sweet", ["ice creams", "vanilla"]),
    ("Ice cream, chocolate", "sweet", ["ice creams", "chocolate"]),
    ("Frozen yogurt", "sweet", ["frozen yogurts", "vanilla", "soft-serve"]),
    ("Whey protein powder", "protein", ["beverages", "protein powder", "whey based"]),
    # ---- Dairy alternatives
    ("Almond milk, unsweetened", "dairy-free", ["beverages", "almond milk", "unsweetened"]),
    ("Soy milk, unsweetened", "dairy-free", ["silk", "unsweetened", "soymilk"]),
    ("Coconut milk, canned", "dairy-free", ["nuts", "coconut milk", "canned"]),
    ("Coconut milk beverage", "dairy-free", ["beverages", "coconut milk", "sweetened"]),
    ("Tofu, firm", "protein", ["tofu", "firm", "prepared with calcium sulfate"]),
    ("Tempeh", "protein", ["tempeh"]),
    ("Edamame, cooked", "protein", ["edamame", "frozen", "prepared"]),
    # ---- Grains, bread, pasta
    ("White rice, cooked", "carb", ["rice", "white", "long-grain", "regular", "cooked", "unenriched"]),
    ("Brown rice, cooked", "carb", ["rice", "brown", "long-grain", "cooked"]),
    ("Jasmine rice, cooked", "carb", ["rice", "white", "long-grain", "regular", "cooked", "enriched"]),
    ("Basmati rice, cooked", "carb", ["rice", "white", "long-grain", "parboiled", "cooked"]),
    ("Wild rice, cooked", "carb", ["wild rice", "cooked"]),
    ("Sushi rice, cooked", "carb", ["rice", "white", "short-grain", "cooked"]),
    ("Quinoa, cooked", "carb", ["quinoa", "cooked"]),
    ("Couscous, cooked", "carb", ["couscous", "cooked"]),
    ("Oatmeal, cooked", "carb", ["cereals", "oats", "regular and quick", "cooked with water", "without salt"]),
    ("Rolled oats, dry", "carb", ["cereals", "oats", "regular and quick", "not fortified", "dry"]),
    ("Granola", "carb", ["cereals ready-to-eat", "granola", "homemade"]),
    ("Cheerios", "carb", ["cereals ready-to-eat", "general mills", "cheerios"]),
    ("Corn flakes", "carb", ["cereals ready-to-eat", "corn flakes"]),
    ("Cream of wheat, cooked", "carb", ["cereals", "cream of wheat", "regular", "cooked with water"]),
    ("Grits, cooked", "carb", ["cereals", "corn grits", "white", "regular", "cooked with water"]),
    ("White bread", "carb", ["bread", "white", "commercially prepared", "(includes soft bread crumbs)"]),
    ("Whole wheat bread", "carb", ["bread", "whole-wheat", "commercially prepared"]),
    ("Sourdough bread", "carb", ["bread", "french or vienna", "sourdough"]),
    ("Rye bread", "carb", ["bread", "rye"]),
    ("Multigrain bread", "carb", ["bread", "multi-grain"]),
    ("Bagel, plain", "carb", ["bagels", "plain", "enriched", "with calcium propionate"]),
    ("English muffin", "carb", ["english muffins", "plain", "enriched", "with calcium propionate"]),
    ("Croissant", "carb", ["croissants", "butter"]),
    ("Hamburger bun", "carb", ["rolls", "hamburger or hotdog", "plain"]),
    ("Dinner roll", "carb", ["rolls", "dinner", "plain", "commercially prepared"]),
    ("Pita bread", "carb", ["bread", "pita", "white", "enriched"]),
    ("Naan", "carb", ["bread", "naan", "plain", "commercially prepared"]),
    ("Flour tortilla", "carb", ["tortillas", "ready-to-bake or -fry", "flour"]),
    ("Corn tortilla", "carb", ["tortillas", "ready-to-bake or -fry", "corn"]),
    ("Cornbread", "carb", ["cornbread", "prepared from recipe"]),
    ("Biscuit", "carb", ["biscuits", "plain or buttermilk", "refrigerated dough", "higher fat", "baked"]),
    ("Pancake", "carb", ["pancakes", "plain", "prepared from recipe"]),
    ("Waffle", "carb", ["waffles", "plain", "prepared from recipe"]),
    ("French toast", "carb", ["french toast", "prepared from recipe", "made with low fat"]),
    ("Spaghetti, cooked", "carb", ["pasta", "cooked", "enriched", "without added salt"]),
    ("Whole wheat pasta, cooked", "carb", ["pasta", "whole-wheat", "cooked"]),
    ("Egg noodles, cooked", "carb", ["noodles", "egg", "cooked", "enriched"]),
    ("Rice noodles, cooked", "carb", ["rice noodles", "cooked"]),
    ("Ramen noodles", "carb", ["soup", "ramen noodle", "any flavor", "dry"]),
    ("Macaroni and cheese", "carb", ["macaroni and cheese", "box mix", "prepared"]),
    ("Lasagna", "meal", ["lasagna", "with meat", "frozen", "prepared"]),
    ("Barley, cooked", "carb", ["barley", "pearled", "cooked"]),
    ("Farro / spelt, cooked", "carb", ["spelt", "cooked"]),
    ("Bulgur, cooked", "carb", ["bulgur", "cooked"]),
    ("Rice cake", "carb", ["rice cakes", "brown rice", "plain"]),
    ("Saltine crackers", "carb", ["crackers", "saltines", "(includes oyster"]),
    ("Graham crackers", "carb", ["graham crackers", "plain or honey", "(includes cinnamon)"]),
    ("Wheat crackers", "carb", ["crackers", "wheat", "regular"]),
    ("Popcorn, air-popped", "carb", ["popcorn", "air-popped"]),
    ("Tortilla chips", "carb", ["tortilla chips", "plain", "white corn"]),
    ("Potato chips", "carb", ["potato chips", "plain", "salted"]),
    ("Pretzels", "carb", ["pretzels", "hard", "plain", "salted"]),
    # ---- Potatoes & starchy veg
    ("Potato, baked, with skin", "carb", ["potatoes", "baked", "flesh and skin", "without salt"]),
    ("Potato, boiled, peeled", "carb", ["potatoes", "boiled", "cooked without skin", "flesh", "without salt"]),
    ("Mashed potatoes", "carb", ["potatoes", "mashed", "home-prepared", "whole milk and butter"]),
    ("French fries", "carb", ["fast foods", "potato", "french fried"]),
    ("Hash browns", "carb", ["potatoes", "hash brown", "home-prepared"]),
    ("Tater tots", "carb", ["potatoes", "frozen", "french fried", "cottage-cut", "heated"]),
    ("Sweet potato, baked", "carb", ["sweet potato", "cooked", "baked in skin", "flesh", "without salt"]),
    ("Sweet potato, boiled", "carb", ["sweet potato", "cooked", "boiled", "without skin"]),
    ("Sweet potato fries", "carb", ["sweet potato", "frozen", "cooked", "baked", "without salt"]),
    ("Butternut squash, baked", "vegetable", ["squash", "winter", "butternut", "cooked", "baked", "without salt"]),
    ("Acorn squash, baked", "vegetable", ["squash", "winter", "acorn", "cooked", "baked", "without salt"]),
    ("Spaghetti squash, cooked", "vegetable", ["squash", "winter", "spaghetti", "cooked", "without salt"]),
    ("Pumpkin, canned", "vegetable", ["pumpkin", "canned", "without salt"]),
    ("Corn on the cob", "vegetable", ["corn", "sweet", "yellow", "cooked", "boiled", "drained", "without salt"]),
    ("Corn, canned", "vegetable", ["corn", "sweet", "yellow", "canned", "whole kernel", "drained solids"]),
    ("Peas, cooked", "vegetable", ["peas", "green", "frozen", "cooked", "boiled", "drained", "without salt"]),
    ("Plantain, cooked", "carb", ["plantains", "yellow", "baked"]),
    ("Cassava, raw", "carb", ["cassava", "raw"]),
    ("Taro, cooked", "carb", ["taro", "cooked", "without salt"]),
    ("Parsnips, cooked", "vegetable", ["parsnips", "cooked", "boiled", "drained", "without salt"]),
    # ---- Vegetables
    ("Broccoli, cooked", "vegetable", ["broccoli", "cooked", "boiled", "drained", "without salt"]),
    ("Broccoli, raw", "vegetable", ["broccoli", "raw"]),
    ("Cauliflower, cooked", "vegetable", ["cauliflower", "cooked", "boiled", "drained", "without salt"]),
    ("Cauliflower, raw", "vegetable", ["cauliflower", "raw"]),
    ("Brussels sprouts, cooked", "vegetable", ["brussels sprouts", "cooked", "boiled", "drained", "without salt"]),
    ("Cabbage, raw", "vegetable", ["cabbage", "raw"]),
    ("Cabbage, cooked", "vegetable", ["cabbage", "cooked", "boiled", "drained", "without salt"]),
    ("Kale, raw", "vegetable", ["kale", "raw"]),
    ("Kale, cooked", "vegetable", ["kale", "cooked", "boiled", "drained", "without salt"]),
    ("Spinach, raw", "vegetable", ["spinach", "raw"]),
    ("Spinach, cooked", "vegetable", ["spinach", "cooked", "boiled", "drained", "without salt"]),
    ("Romaine lettuce", "vegetable", ["lettuce", "cos or romaine", "raw"]),
    ("Iceberg lettuce", "vegetable", ["lettuce", "iceberg", "raw"]),
    ("Mixed greens", "vegetable", ["lettuce", "green leaf", "raw"]),
    ("Arugula", "vegetable", ["arugula", "raw"]),
    ("Swiss chard, cooked", "vegetable", ["chard", "swiss", "cooked", "boiled", "drained", "without salt"]),
    ("Collard greens, cooked", "vegetable", ["collards", "cooked", "boiled", "drained", "without salt"]),
    ("Bok choy, cooked", "vegetable", ["cabbage", "chinese", "pak-choi", "cooked", "boiled", "drained", "without salt"]),
    ("Carrot, raw", "vegetable", ["carrots", "raw"]),
    ("Carrot, cooked", "vegetable", ["carrots", "cooked", "boiled", "drained", "without salt"]),
    ("Celery, raw", "vegetable", ["celery", "raw"]),
    ("Cucumber", "vegetable", ["cucumber", "with peel", "raw"]),
    ("Tomato, raw", "vegetable", ["tomatoes", "red", "ripe", "raw", "year round average"]),
    ("Cherry tomatoes", "vegetable", ["tomatoes", "red", "ripe", "raw", "year round average"]),
    ("Tomato sauce", "vegetable", ["tomato sauce", "canned", "no salt added"]),
    ("Crushed tomatoes, canned", "vegetable", ["tomatoes", "red", "ripe", "canned", "packed in tomato juice"]),
    ("Tomato paste", "vegetable", ["tomato products", "canned", "paste", "without salt"]),
    ("Marinara sauce", "vegetable", ["sauce", "pasta", "spaghetti/marinara", "ready-to-serve"]),
    ("Salsa", "vegetable", ["sauce", "salsa", "ready-to-serve"]),
    ("Bell pepper, red", "vegetable", ["peppers", "sweet", "red", "raw"]),
    ("Bell pepper, green", "vegetable", ["peppers", "sweet", "green", "raw"]),
    ("Jalapeño", "vegetable", ["peppers", "jalapeno", "raw"]),
    ("Onion, raw", "vegetable", ["onions", "raw"]),
    ("Onion, sautéed", "vegetable", ["onions", "cooked", "boiled", "drained", "without salt"]),
    ("Green onion", "vegetable", ["onions", "spring or scallions", "raw"]),
    ("Garlic", "vegetable", ["garlic", "raw"]),
    ("Mushrooms, raw", "vegetable", ["mushrooms", "white", "raw"]),
    ("Mushrooms, cooked", "vegetable", ["mushrooms", "white", "cooked", "boiled", "drained", "without salt"]),
    ("Portobello mushroom, grilled", "vegetable", ["mushrooms", "portabella", "grilled"]),
    ("Zucchini, raw", "vegetable", ["squash", "summer", "zucchini", "includes skin", "raw"]),
    ("Zucchini, cooked", "vegetable", ["squash", "summer", "zucchini", "includes skin", "cooked", "boiled", "drained", "without salt"]),
    ("Yellow squash, cooked", "vegetable", ["squash", "summer", "crookneck and straightneck", "cooked", "boiled", "drained", "without salt"]),
    ("Eggplant, cooked", "vegetable", ["eggplant", "cooked", "boiled", "drained", "without salt"]),
    ("Asparagus, cooked", "vegetable", ["asparagus", "cooked", "boiled", "drained"]),
    ("Green beans, cooked", "vegetable", ["beans", "snap", "green", "cooked", "boiled", "drained", "without salt"]),
    ("Artichoke, cooked", "vegetable", ["artichokes", "(globe or french)", "cooked", "boiled", "drained", "without salt"]),
    ("Beets, cooked", "vegetable", ["beets", "cooked", "boiled", "drained"]),
    ("Radish", "vegetable", ["radishes", "raw"]),
    ("Avocado", "fat", ["avocados", "raw", "all commercial varieties"]),
    ("Olives, black", "fat", ["olives", "ripe", "canned", "(small-extra large)"]),
    ("Olives, green", "fat", ["olives", "pickled", "canned or bottled", "green"]),
    ("Pickles, dill", "vegetable", ["pickles", "cucumber", "dill or kosher dill"]),
    ("Sauerkraut", "vegetable", ["sauerkraut", "canned", "solids and liquids"]),
    ("Kimchi", "vegetable", ["kimchi"]),
    ("Seaweed, nori", "vegetable", ["seaweed", "laver", "raw"]),
    ("Coleslaw", "vegetable", ["kfc", "coleslaw"]),
    ("Vegetable soup", "meal", ["soup", "vegetarian vegetable", "canned", "prepared with equal volume water"]),
    ("Miso paste", "meal", ["miso"]),
    # ---- Legumes
    ("Black beans, cooked", "carb", ["beans", "black", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Pinto beans, cooked", "carb", ["beans", "pinto", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Kidney beans, cooked", "carb", ["beans", "kidney", "all types", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Chickpeas, cooked", "carb", ["chickpeas", "(garbanzo beans", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Lentils, cooked", "carb", ["lentils", "mature seeds", "cooked", "boiled", "without salt"]),
    ("White beans, cooked", "carb", ["beans", "white", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Navy beans, cooked", "carb", ["beans", "navy", "mature seeds", "cooked", "boiled", "without salt"]),
    ("Refried beans", "carb", ["refried beans", "canned", "traditional"]),
    ("Baked beans", "carb", ["beans", "baked", "canned", "plain or vegetarian"]),
    ("Hummus", "fat", ["hummus", "commercial"]),
    ("Lentil soup", "meal", ["soup", "lentil", "canned", "ready-to-serve"]),
    # ---- Fruit
    ("Apple, with skin", "fruit", ["apples", "raw", "with skin"]),
    ("Applesauce, unsweetened", "fruit", ["applesauce", "canned", "unsweetened", "without added ascorbic acid"]),
    ("Banana", "fruit", ["bananas", "raw"]),
    ("Orange", "fruit", ["oranges", "raw", "all commercial varieties"]),
    ("Clementine", "fruit", ["clementines", "raw"]),
    ("Grapefruit", "fruit", ["grapefruit", "raw", "pink and red", "all areas"]),
    ("Strawberries", "fruit", ["strawberries", "raw"]),
    ("Blueberries", "fruit", ["blueberries", "raw"]),
    ("Raspberries", "fruit", ["raspberries", "raw"]),
    ("Blackberries", "fruit", ["blackberries", "raw"]),
    ("Grapes", "fruit", ["grapes", "red or green", "(european type", "raw"]),
    ("Watermelon", "fruit", ["watermelon", "raw"]),
    ("Cantaloupe", "fruit", ["melons", "cantaloupe", "raw"]),
    ("Honeydew", "fruit", ["melons", "honeydew", "raw"]),
    ("Pineapple", "fruit", ["pineapple", "raw", "all varieties"]),
    ("Mango", "fruit", ["mangos", "raw"]),
    ("Papaya", "fruit", ["papayas", "raw"]),
    ("Kiwi", "fruit", ["kiwifruit", "green", "raw"]),
    ("Peach", "fruit", ["peaches", "raw"]),
    ("Nectarine", "fruit", ["nectarines", "raw"]),
    ("Plum", "fruit", ["plums", "raw"]),
    ("Pear", "fruit", ["pears", "raw"]),
    ("Cherries", "fruit", ["cherries", "sweet", "raw"]),
    ("Apricot", "fruit", ["apricots", "raw"]),
    ("Pomegranate", "fruit", ["pomegranates", "raw"]),
    ("Figs", "fruit", ["figs", "raw"]),
    ("Dates, medjool", "fruit", ["dates", "medjool"]),
    ("Raisins", "fruit", ["raisins", "seedless"]),
    ("Dried cranberries", "fruit", ["cranberries", "dried", "sweetened"]),
    ("Dried apricots", "fruit", ["apricots", "dried", "sulfured", "uncooked"]),
    ("Prunes", "fruit", ["plums", "dried", "(prunes)", "uncooked"]),
    ("Coconut, shredded", "fat", ["nuts", "coconut meat", "dried", "(desiccated)", "sweetened", "flaked"]),
    ("Lemon", "fruit", ["lemons", "raw", "without peel"]),
    ("Lime", "fruit", ["limes", "raw"]),
    ("Fruit cocktail, canned", "fruit", ["fruit cocktail", "canned", "juice pack"]),
    ("Peaches, canned in juice", "fruit", ["peaches", "canned", "juice pack"]),
    ("Pineapple, canned in juice", "fruit", ["pineapple", "canned", "juice pack"]),
    ("Cranberries, raw", "fruit", ["cranberries", "raw"]),
    # ---- Nuts, seeds, nut butters
    ("Almonds", "fat", ["nuts", "almonds"]),
    ("Walnuts", "fat", ["nuts", "walnuts", "english"]),
    ("Cashews", "fat", ["nuts", "cashew nuts", "raw"]),
    ("Pecans", "fat", ["nuts", "pecans"]),
    ("Pistachios", "fat", ["nuts", "pistachio nuts", "raw"]),
    ("Peanuts", "fat", ["peanuts", "all types", "dry-roasted", "with salt"]),
    ("Macadamia nuts", "fat", ["nuts", "macadamia nuts", "raw"]),
    ("Hazelnuts", "fat", ["nuts", "hazelnuts or filberts"]),
    ("Brazil nuts", "fat", ["nuts", "brazilnuts", "dried", "unblanched"]),
    ("Pine nuts", "fat", ["nuts", "pine nuts", "dried"]),
    ("Mixed nuts", "fat", ["nuts", "mixed nuts", "dry roasted", "with peanuts", "with salt"]),
    ("Peanut butter", "fat", ["peanut butter", "smooth style", "with salt"]),
    ("Almond butter", "fat", ["nuts", "almond butter", "plain", "with salt"]),
    ("Cashew butter", "fat", ["nuts", "cashew butter", "plain", "with salt"]),
    ("Sunflower seed butter", "fat", ["seeds", "sunflower seed butter", "with salt"]),
    ("Tahini", "fat", ["seeds", "sesame butter", "tahini", "from roasted"]),
    ("Chia seeds", "fat", ["seeds", "chia seeds", "dried"]),
    ("Flax seeds", "fat", ["seeds", "flaxseed"]),
    ("Hemp seeds", "fat", ["seeds", "hemp seed", "hulled"]),
    ("Sunflower seeds", "fat", ["seeds", "sunflower seed kernels", "dry roasted", "with salt"]),
    ("Pumpkin seeds", "fat", ["seeds", "pumpkin and squash seed kernels", "dried"]),
    ("Sesame seeds", "fat", ["seeds", "sesame seeds", "whole", "dried"]),
    ("Trail mix", "fat", ["snacks", "trail mix", "regular"]),
    # ---- Oils, fats, condiments
    ("Olive oil", "fat", ["oil", "olive", "salad or cooking"]),
    ("Avocado oil", "fat", ["oil", "avocado"]),
    ("Coconut oil", "fat", ["oil", "coconut"]),
    ("Canola oil", "fat", ["oil", "canola"]),
    ("Vegetable oil", "fat", ["oil", "soybean", "salad or cooking"]),
    ("Sesame oil", "fat", ["oil", "sesame", "salad or cooking"]),
    ("Lard", "fat", ["lard"]),
    ("Margarine", "fat", ["margarine", "regular", "80% fat", "composite", "stick", "with salt"]),
    ("Mayonnaise", "fat", ["salad dressing", "mayonnaise", "regular"]),
    ("Light mayonnaise", "fat", ["salad dressing", "mayonnaise", "light"]),
    ("Ranch dressing", "fat", ["salad dressing", "ranch dressing", "regular"]),
    ("Italian dressing", "fat", ["salad dressing", "italian dressing", "commercial", "regular"]),
    ("Caesar dressing", "fat", ["salad dressing", "caesar dressing", "regular"]),
    ("Blue cheese dressing", "fat", ["salad dressing", "blue or roquefort cheese dressing", "commercial", "regular"]),
    ("Ketchup", "condiment", ["catsup"]),
    ("Mustard, yellow", "condiment", ["mustard", "prepared", "yellow"]),
    ("BBQ sauce", "condiment", ["sauce", "barbecue"]),
    ("Soy sauce", "condiment", ["soy sauce", "made from soy and wheat", "(shoyu)"]),
    ("Hot sauce", "condiment", ["sauce", "ready-to-serve", "pepper or hot"]),
    ("Sriracha", "condiment", ["sauce", "hot chile", "sriracha"]),
    ("Teriyaki sauce", "condiment", ["sauce", "teriyaki", "ready-to-serve"]),
    ("Vinegar", "condiment", ["vinegar", "distilled"]),
    ("Balsamic vinegar", "condiment", ["vinegar", "balsamic"]),
    ("Pesto", "fat", ["sauce", "pesto", "ready-to-serve"]),
    ("Chicken broth", "condiment", ["soup", "chicken broth", "ready-to-serve"]),
    # ---- Sweets & snacks
    ("Dark chocolate 70%", "sweet", ["chocolate", "dark", "70-85% cacao"]),
    ("Milk chocolate", "sweet", ["candies", "milk chocolate"]),
    ("Chocolate chips", "sweet", ["candies", "semisweet chocolate"]),
    ("Chocolate chip cookie", "sweet", ["cookies", "chocolate chip", "commercially prepared", "regular", "higher fat"]),
    ("Oatmeal cookie", "sweet", ["cookies", "oatmeal", "commercially prepared", "regular"]),
    ("Oreo cookie", "sweet", ["cookies", "chocolate sandwich", "with creme filling", "regular"]),
    ("Brownie", "sweet", ["cookies", "brownies", "commercially prepared"]),
    ("Chocolate cake", "sweet", ["cake", "chocolate", "commercially prepared with chocolate frosting"]),
    ("Cheesecake", "sweet", ["cake", "cheesecake", "commercially prepared"]),
    ("Donut, glazed", "sweet", ["doughnuts", "yeast-leavened", "glazed", "enriched"]),
    ("Muffin, blueberry", "sweet", ["muffins", "blueberry", "commercially prepared"]),
    ("Banana bread", "sweet", ["bread", "banana", "prepared from recipe", "made with margarine"]),
    ("Cinnamon roll", "sweet", ["sweet rolls", "cinnamon", "commercially prepared with raisins"]),
    ("Apple pie", "sweet", ["pie", "apple", "commercially prepared", "enriched flour"]),
    ("Pumpkin pie", "sweet", ["pie", "pumpkin", "commercially prepared"]),
    ("Pudding, chocolate", "sweet", ["puddings", "chocolate", "ready-to-eat"]),
    ("Jello", "sweet", ["gelatin desserts", "dry mix", "prepared with water"]),
    ("Gummy bears", "sweet", ["candies", "gumdrops", "starch jelly pieces"]),
    ("Hard candy", "sweet", ["candies", "hard"]),
    ("Snickers bar", "sweet", ["candies", "mars snackfood us", "snickers bar"]),
    ("M&M's", "sweet", ["candies", "mars snackfood us", "m&m's milk chocolate candies"]),
    ("Reese's cup", "sweet", ["candies", "reese's peanut butter cups"]),
    ("Kit Kat", "sweet", ["candies", "kit kat"]),
    ("Marshmallows", "sweet", ["candies", "marshmallows"]),
    ("Granola bar", "sweet", ["snacks", "granola bars", "hard", "plain"]),
    ("Granola bar, soft, peanut butter", "protein", ["snacks", "granola bar", "soft", "coated", "peanut butter"]),
    ("Fruit snacks", "sweet", ["snacks", "fruit leather", "rolls"]),
    ("Pop-Tart", "sweet", ["toaster pastries", "fruit", "frosted", "(include apples"]),
    ("Cheese crackers (Goldfish)", "carb", ["crackers", "cheese", "regular"]),
    ("Beef stick", "protein", ["snacks", "beef sticks", "smoked"]),
    ("Pork rinds", "protein", ["snacks", "pork skins", "plain"]),
    # ---- Beverages
    ("Coffee, black", "drink", ["beverages", "coffee", "brewed", "prepared with tap water"]),
    ("Espresso", "drink", ["beverages", "coffee", "brewed", "espresso", "restaurant-prepared"]),
    ("Tea, black", "drink", ["beverages", "tea", "black", "brewed", "prepared with tap water"]),
    ("Green tea", "drink", ["beverages", "tea", "green", "brewed", "regular"]),
    ("Orange juice", "drink", ["orange juice", "raw"]),
    ("Apple juice", "drink", ["apple juice", "canned or bottled", "unsweetened", "without added ascorbic acid"]),
    ("Cranberry juice", "drink", ["cranberry juice", "unsweetened"]),
    ("Grape juice", "drink", ["grape juice", "canned or bottled", "unsweetened", "without added ascorbic acid"]),
    ("Lemonade", "drink", ["beverages", "lemonade", "frozen concentrate", "prepared with water"]),
    ("Coconut water", "drink", ["nuts", "coconut water", "(liquid from coconuts)"]),
    ("Cola", "drink", ["beverages", "carbonated", "cola", "regular"]),
    ("Diet cola", "drink", ["beverages", "carbonated", "low calorie", "cola or pepper-type"]),
    ("Ginger ale", "drink", ["beverages", "carbonated", "ginger ale"]),
    ("Energy drink (Red Bull)", "drink", ["beverages", "energy drink", "red bull"]),
    ("Protein shake, ready-to-drink (SlimFast)", "drink", ["beverages", "protein", "shake", "ready-to-drink"]),
    ("Hot chocolate", "drink", ["beverages", "chocolate-flavor beverage mix", "prepared with whole milk"]),
    ("Beer", "drink", ["alcoholic beverage", "beer", "regular", "all"]),
    ("Light beer", "drink", ["alcoholic beverage", "beer", "light"]),
    ("Red wine", "drink", ["alcoholic beverage", "wine", "table", "red"]),
    ("White wine", "drink", ["alcoholic beverage", "wine", "table", "white"]),
    ("Vodka / spirits, 80 proof", "drink", ["alcoholic beverage", "distilled", "all", "80 proof"]),
    # ---- Fast food & prepared meals
    ("Cheeseburger, fast food", "meal", ["fast foods", "cheeseburger", "single", "regular patty", "with condiments"]),
    ("Hamburger, fast food", "meal", ["fast foods", "hamburger", "single", "regular patty", "with condiments"]),
    ("Chicken sandwich, fried", "meal", ["fast foods", "chicken", "fillet sandwich", "plain"]),
    ("Chicken nuggets", "meal", ["mcdonald's", "chicken mcnuggets"]),
    ("Fried chicken breast", "meal", ["fast foods", "fried chicken", "breast", "meat and skin"]),
    ("Pizza, cheese", "meal", ["pizza", "cheese topping", "regular crust", "frozen", "cooked"]),
    ("Pizza, pepperoni", "meal", ["pizza", "pepperoni topping", "regular crust", "frozen", "cooked"]),
    ("Taco, beef", "meal", ["fast foods", "taco", "with beef", "cheese and lettuce"]),
    ("Burrito, bean and cheese", "meal", ["fast foods", "burrito", "with beans and cheese"]),
    ("Burrito, beef", "meal", ["taco bell", "burrito supreme with beef"]),
    ("Egg McMuffin", "meal", ["fast foods", "english muffin", "with egg", "cheese", "and canadian bacon"]),
    ("Breakfast burrito", "meal", ["fast foods", "breakfast burrito", "with egg"]),
    ("Sub sandwich, cold cut", "meal", ["fast foods", "submarine sandwich", "cold cut", "on white bread"]),
    ("Turkey sandwich", "meal", ["fast foods", "submarine sandwich", "turkey", "roast beef and ham"]),
    ("BLT sandwich", "meal", ["fast foods", "bacon", "lettuce", "tomato"]),
    ("Onion rings", "meal", ["fast foods", "onion rings", "breaded and fried"]),
    ("Mozzarella sticks", "meal", ["denny's", "mozzarella cheese sticks"]),
    ("Fried rice", "meal", ["restaurant", "chinese", "fried rice", "without meat"]),
    ("General Tso's chicken", "meal", ["restaurant", "chinese", "general tso's chicken"]),
    ("Orange chicken", "meal", ["restaurant", "chinese", "orange chicken"]),
    ("Beef and broccoli", "meal", ["restaurant", "chinese", "beef and vegetables"]),
    ("Sesame chicken", "meal", ["restaurant", "chinese", "sesame chicken"]),
    ("Kung pao chicken", "meal", ["restaurant", "chinese", "kung pao chicken"]),
    ("Sweet and sour pork", "meal", ["restaurant", "chinese", "sweet and sour pork"]),
    ("Lo mein", "meal", ["restaurant", "chinese", "lo mein", "without meat"]),
    ("Egg roll", "meal", ["restaurant", "chinese", "egg rolls", "assorted"]),
    ("Spaghetti with meat sauce", "meal", ["spaghetti", "with meat sauce", "frozen entree"]),
    ("Beef stew", "meal", ["beef stew", "canned entree"]),
    ("Chili con carne", "meal", ["chili con carne", "with beans", "canned entree"]),
    ("Chicken pot pie", "meal", ["chicken pot pie", "frozen entree"]),
    ("Quesadilla, chicken", "meal", ["fast foods", "quesadilla", "with chicken"]),
    ("Nachos with cheese", "meal", ["fast foods", "nachos", "with cheese"]),
    ("Enchilada, cheese", "meal", ["restaurant", "mexican", "cheese enchilada"]),
    ("Falafel", "meal", ["falafel", "home-prepared"]),
    ("Ramen bowl", "meal", ["soup", "ramen noodle", "chicken flavor", "dry"]),
    ("Clam chowder", "meal", ["soup", "clam chowder", "new england", "canned", "prepared with equal volume low fat"]),
    ("Potato salad", "meal", ["potato salad", "home-prepared"]),
    ("Tuna salad", "meal", ["tuna salad"]),
    ("Omelet, cheese", "meal", ["egg", "whole", "cooked", "omelet"]),
    ("Chicken soup, homemade", "meal", ["soup", "chicken", "canned", "chunky", "ready-to-serve"]),
    ("Chicken and rice", "meal", ["restaurant", "latino", "chicken and rice", "entree"]),
    ("Chicken parmesan", "meal", ["chicken parmesan"]),
    ("Dumplings, potato & cheese (pierogi)", "meal", ["dumpling", "potato- or cheese-filled", "frozen"]),
    ("Spring roll", "meal", ["egg rolls", "vegetable", "frozen", "prepared"]),
    ("Corn dog", "meal", ["corn dogs", "frozen", "prepared"]),
    ("Chicken tenders", "meal", ["fast foods", "chicken tenders"]),
    ("Fish sandwich, fast food", "meal", ["fast foods", "fish sandwich", "with tartar sauce"]),
    ("Shrimp, breaded and fried", "meal", ["fast foods", "shrimp", "breaded and fried"]),
    ("Fruit salad", "fruit", ["fruit salad", "(peach and pear and apricot and pineapple and cherry)", "canned", "juice pack"]),
    ("Overnight oats", "carb", ["cereals", "oats", "regular and quick", "cooked with water", "without salt"]),
    ("Baby food pouch, vegetable", "vegetable", ["babyfood", "vegetable", "butternut squash and corn"]),
    ("Water", "drink", ["water", "bottled", "generic"]),
]

# Phase 18 W1 universe staples (docs/catalog/universe.md): commonly eaten whole foods of the 12
# cuisine packs that the list above did not carry. Plain, unbranded SR Legacy rows only. Their
# off-plan flags read the SR description as well as the name (lib/food-db.test.ts's floor).
UNIVERSE_STAPLES = [
    ("Jicama, raw", "vegetable", ["yambean (jicama), raw"]),
    ("Chayote, cooked", "vegetable", ["chayote", "fruit", "cooked", "without salt"]),
    ("Nopales, cooked", "vegetable", ["nopales", "cooked", "without salt"]),
    ("Tomatillos, raw", "vegetable", ["tomatillos, raw"]),
    ("Cilantro, fresh", "vegetable", ["coriander (cilantro) leaves, raw"]),
    ("Queso fresco", "dairy", ["cheese, fresh, queso fresco"]),
    ("Hominy, canned", "carb", ["hominy, canned, white"]),
    ("Guava", "fruit", ["guavas, common, raw"]),
    ("Fennel, raw", "vegetable", ["fennel, bulb, raw"]),
    ("Basil, fresh", "vegetable", ["basil, fresh"]),
    ("Parsley, fresh", "vegetable", ["parsley, fresh"]),
    ("Mint, fresh", "vegetable", ["spearmint, fresh"]),
    ("Grape leaves, raw", "vegetable", ["grape leaves, raw"]),
    ("Fava beans, cooked", "carb", ["broadbeans (fava beans), mature seeds, cooked, boiled, without salt"]),
    ("Octopus, cooked", "protein", ["mollusks", "octopus", "common", "cooked", "moist heat"]),
    ("Pigeon peas (toor dal), cooked", "carb", ["pigeon peas", "mature seeds", "cooked", "without salt"]),
    ("Mung beans (moong dal), cooked", "carb", ["mung beans, mature seeds, cooked, boiled, without salt"]),
    ("Black gram (urad dal), cooked", "carb", ["mungo beans, mature seeds, cooked, boiled, without salt"]),
    ("Split peas, cooked", "carb", ["peas, split, mature seeds, cooked, boiled, without salt"]),
    ("Okra, cooked", "vegetable", ["okra, cooked, boiled, drained, without salt"]),
    ("Bitter gourd, cooked", "vegetable", ["balsam-pear", "pods", "cooked", "without salt"]),
    ("Chapati (roti)", "carb", ["bread, chapati or roti, plain, commercially prepared"]),
    ("Goat, roasted", "protein", ["game meat, goat, cooked, roasted"]),
    ("Napa cabbage, cooked", "vegetable", ["cabbage, chinese (pe-tsai), cooked", "without salt"]),
    ("Snow peas, cooked", "vegetable", ["peas, edible-podded, boiled, drained, without salt"]),
    ("Mung bean sprouts, raw", "vegetable", ["mung beans, mature seeds, sprouted, raw"]),
    ("Shiitake mushrooms, cooked", "vegetable", ["mushrooms, shiitake, cooked, without salt"]),
    ("Chinese broccoli (gai lan), cooked", "vegetable", ["broccoli, chinese, cooked"]),
    ("Bamboo shoots, canned", "vegetable", ["bamboo shoots, canned, drained solids"]),
    ("Water chestnuts, raw", "vegetable", ["waterchestnuts, chinese, (matai), raw"]),
    ("Lotus root, cooked", "vegetable", ["lotus root", "cooked", "without salt"]),
    ("Adzuki beans, cooked", "carb", ["beans, adzuki, mature seeds, cooked, boiled, without salt"]),
    ("Soba noodles, cooked", "carb", ["noodles, japanese, soba, cooked"]),
    ("Wakame seaweed", "vegetable", ["seaweed, wakame, raw"]),
    ("Daikon, cooked", "vegetable", ["radishes, oriental, cooked, boiled, drained, without salt"]),
    ("Natto", "protein", ["natto"]),
    ("Soybean sprouts, cooked", "vegetable", ["soybeans, mature seeds, sprouted, cooked, steamed"]),
    ("Asian pear", "fruit", ["pears, asian, raw"]),
    ("Jackfruit, raw", "fruit", ["jackfruit, raw"]),
    ("Lychee", "fruit", ["litchis, raw"]),
    ("Tamarind", "fruit", ["tamarinds, raw"]),
    ("Lemongrass", "vegetable", ["lemon grass (citronella), raw"]),
    ("Yardlong beans, cooked", "vegetable", ["yardlong bean, cooked, boiled, drained, without salt"]),
    ("Yam, cooked", "carb", ["yam, cooked, boiled, drained, or baked, without salt"]),
    ("Breadfruit", "carb", ["breadfruit, raw"]),
    ("Green plantain, boiled", "carb", ["plantains, green, boiled"]),
    ("Callaloo (amaranth leaves), cooked", "vegetable", ["amaranth leaves, cooked", "without salt"]),
    ("Black-eyed peas, cooked", "carb", ["cowpeas, common", "mature seeds, cooked, boiled, without salt"]),
    ("Pumpkin, cooked", "vegetable", ["pumpkin, cooked, boiled, drained, without salt"]),
    ("Teff, cooked", "carb", ["teff, cooked"]),
    ("Millet, cooked", "carb", ["millet, cooked"]),
    ("Sweet potato leaves, cooked", "vegetable", ["sweet potato leaves, cooked, steamed, without salt"]),
    ("Buckwheat groats (kasha), cooked", "carb", ["buckwheat groats, roasted, cooked"]),
    ("Turnips, cooked", "vegetable", ["turnips, cooked, boiled, drained, without salt"]),
    ("Rutabaga, cooked", "vegetable", ["rutabagas, cooked, boiled, drained, without salt"]),
    ("Kohlrabi, cooked", "vegetable", ["kohlrabi, cooked, boiled, drained, without salt"]),
    ("Celeriac, cooked", "vegetable", ["celeriac, cooked, boiled, drained, without salt"]),
    ("Leeks, cooked", "vegetable", ["leeks", "cooked, boiled, drained, without salt"]),
    ("Red cabbage, cooked", "vegetable", ["cabbage, red, cooked, boiled, drained, without salt"]),
    ("Gouda cheese", "dairy", ["cheese, gouda"]),
    ("Herring, cooked", "protein", ["fish, herring, atlantic, cooked, dry heat"]),
    ("Watercress, raw", "vegetable", ["watercress, raw"]),
    ("Dandelion greens, cooked", "vegetable", ["dandelion greens, cooked", "without salt"]),
]

# Not in SR Legacy. Values from product labels (per 100 g or 100 ml).
EXTRA = [
    ("oat-milk", "Oat milk (barista style)", "dairy-free", {"kcal": 60, "protein": 1.0, "carbs": 7.0, "fat": 3.0, "fiber": 0.8}, [{"label": "1 cup", "grams": 240}, {"label": "1 fl oz", "grams": 30}], "Oatly Barista label"),
    ("oat-milk-latte", "Oat milk latte (12 oz)", "drink", {"kcal": 37, "protein": 0.9, "carbs": 4.8, "fat": 1.4, "fiber": 0.5}, [{"label": "1 latte (12 oz)", "grams": 355}, {"label": "1 small (8 oz)", "grams": 240}], "her food log, Koatji oat milk"),
    ("prosciutto", "Prosciutto", "protein", {"kcal": 250, "protein": 26.0, "carbs": 0.0, "fat": 16.0, "fiber": 0.0}, [{"label": "1 slice", "grams": 15}, {"label": "1 oz", "grams": 28.35}], "typical deli label"),
    ("guacamole", "Guacamole", "fat", {"kcal": 150, "protein": 2.0, "carbs": 8.0, "fat": 13.0, "fiber": 6.0}, [{"label": "2 tbsp", "grams": 30}, {"label": "1/4 cup", "grams": 60}], "typical label"),
    ("kombucha", "Kombucha", "drink", {"kcal": 13, "protein": 0.0, "carbs": 3.0, "fat": 0.0, "fiber": 0.0}, [{"label": "1 bottle (16 oz)", "grams": 480}, {"label": "1 cup", "grams": 240}], "GT's label"),
    ("bone-broth-protein", "Bone broth protein, Paleovalley (collagen — does not count toward protein target)", "supplement", {"kcal": 421, "protein": 68.4, "carbs": 2.6, "fat": 10.5, "fiber": 0.0}, [{"label": "1 scoop", "grams": 19}], "her Paleovalley label: 80 kcal, 13 g protein per 19 g scoop"),
    ("avocado-mayo-primal", "Avocado oil mayo, Primal Kitchen", "fat", {"kcal": 714, "protein": 0.0, "carbs": 0.0, "fat": 78.6, "fiber": 0.0}, [{"label": "1 tbsp", "grams": 14}], "her Primal Kitchen label: 100 kcal, 11 g fat per tbsp"),
    ("om-hot-chocolate-mix", "Om mushroom hot chocolate mix", "drink", {"kcal": 375, "protein": 12.5, "carbs": 75.0, "fat": 6.3, "fiber": 25.0}, [{"label": "1 tbsp", "grams": 8}], "her Om label: 30 kcal per 8 g"),
    ("fruit-pouch", "Fruit pouch, pear or banana base (3.5 oz)", "fruit", {"kcal": 71, "protein": 0.5, "carbs": 17.0, "fat": 0.0, "fiber": 2.0}, [{"label": "1 pouch", "grams": 99}], "typical apple-free pouch label"),
]

# Off-plan flags for Sasha (colitis plan): gluten, dairy, apple. Name-based.
DAIRY = re.compile(r"\b(milk|cheese|yogurt|butter|cream|whey|ghee|ice cream|cheesecake|latte|cappuccino|alfredo|ricotta|feta|brie|mozzarella|parmesan|cheddar|provolone|swiss|pudding|frozen yogurt|hot chocolate|chocolate milk)\b", re.I)
DAIRY_OK = re.compile(r"\b(almond milk|oat milk|soy milk|coconut milk|coconut water|peanut butter|almond butter|cashew butter|sesame butter|sunflower seed butter|cocoa butter|butternut|buttercup)\b", re.I)
GLUTEN = re.compile(r"\b(bread|bagel|muffin|croissant|bun|roll|pita|naan|flour tortilla|pancake|waffle|french toast|spaghetti|pasta|noodle|couscous|barley|farro|spelt|wheat|rye|semolina|malt|bulgur|cracker|pretzel|cookie|brownie|cake|donut|pie|cinnamon|pop-tart|ramen|lo mein|dumpling|pierogi|sandwich|burger|pizza|burrito|quesadilla|enchilada|egg roll|spring roll|corn dog|mac|macaroni|lasagna|ziti|gnocchi|biscuit|cornbread|granola|cheerios|corn flakes|cream of wheat|beer|soy sauce|teriyaki|fish sticks|breaded|fried chicken|chicken nuggets|chicken tenders|onion rings|mozzarella sticks|crab cake|meatball|meatloaf|pot pie|gyro|sub |toast|graham|goldfish|rice krispies|oatmeal cookie|oreo|kit kat|falafel|shepherd)\b", re.I)
GLUTEN_OK = re.compile(r"\b(rice noodles|corn tortilla|rice cake|buckwheat|quinoa|gluten-free)\b", re.I)
APPLE = re.compile(r"\bapple", re.I)


# Off-plan flags the name rule above misses, reviewed by hand in audit 2026-09-13 findings #23 and
# #28 (PR #131) from each row's own SR text. They replace the computed list for that id, in this
# order, so a regenerated JSON keeps every flag the bundled list already shipped.
FLAG_OVERRIDES = {
    "half-and-half": ["dairy"],
    "croissant": ["gluten", "dairy"],
    "cornbread": ["gluten", "dairy"],
    "french-toast": ["gluten", "dairy"],
    "egg-noodles-cooked": ["gluten"],
    "saltine-crackers": ["gluten"],
    "mashed-potatoes": ["dairy"],
    "cheesecake": ["dairy", "gluten"],
    "m-m-s": ["dairy"],
    "pop-tart": ["gluten", "apple"],
    "cheeseburger-fast-food": ["gluten", "dairy"],
    "taco-beef": ["dairy"],
    "egg-mcmuffin": ["gluten", "dairy"],
    "breakfast-burrito": ["gluten", "dairy"],
    "clam-chowder": ["dairy"],
    "chicken-parmesan": ["dairy", "gluten"],
}


def flags(name: str) -> list[str]:
    out = []
    if APPLE.search(name):
        out.append("apple")
    if GLUTEN.search(name) and not GLUTEN_OK.search(name):
        out.append("gluten")
    if DAIRY.search(name) and not DAIRY_OK.search(name):
        out.append("dairy")
    return out


def load():
    foods, categories, group = {}, {}, {}
    with open(f"{SR}/food_category.csv", newline="") as f:
        for row in csv.DictReader(f):
            group[row["id"]] = row["description"]
    with open(f"{SR}/food.csv", newline="") as f:
        for row in csv.DictReader(f):
            foods[row["fdc_id"]] = row["description"]
            categories[row["fdc_id"]] = group.get(row["food_category_id"])
    nutrients = defaultdict(dict)
    with open(f"{SR}/food_nutrient.csv", newline="") as f:
        for row in csv.DictReader(f):
            key = NUTRIENTS.get(row["nutrient_id"])
            if key:
                nutrients[row["fdc_id"]][key] = float(row["amount"])
    units = {}
    with open(f"{SR}/measure_unit.csv", newline="") as f:
        for row in csv.DictReader(f):
            units[row["id"]] = row["name"]
    portions = defaultdict(list)
    with open(f"{SR}/food_portion.csv", newline="") as f:
        for row in csv.DictReader(f):
            unit = units.get(row["measure_unit_id"], "")
            desc = (row.get("portion_description") or "").strip()
            mod = (row.get("modifier") or "").strip()
            label = " ".join(x for x in [row["amount"].rstrip("0").rstrip("."), unit if unit != "undetermined" else "", desc, mod] if x)
            label = re.sub(r"\s+", " ", label).strip()
            try:
                grams = float(row["gram_weight"])
            except ValueError:
                continue
            if grams > 0 and label:
                portions[row["fdc_id"]].append({"label": label, "grams": round(grams, 1)})
    return foods, nutrients, portions, categories


def pick(foods, keywords):
    kws = [k.lower() for k in keywords]
    hits = [(len(d), fid, d) for fid, d in foods.items() if all(k in d.lower() for k in kws)]
    if not hits:
        return None
    hits.sort()
    return hits[0][1], hits[0][2]


def slug(s):
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


def main():
    foods, nutrients, portions, categories = load()
    out, misses, seen = [], [], set()
    staples = {name for name, _, _ in UNIVERSE_STAPLES}
    for name, cat, kws in CURATED + UNIVERSE_STAPLES:
        hit = pick(foods, kws)
        if not hit:
            misses.append((name, kws))
            continue
        fid, desc = hit
        n = nutrients.get(fid, {})
        if "kcal" not in n or "protein" not in n:
            misses.append((name, kws))
            continue
        sid = slug(name)
        if sid in seen:
            sid = f"{sid}-2"
        seen.add(sid)
        ports = portions.get(fid, [])[:8]
        if not ports:
            ports = [{"label": "1 oz", "grams": 28.35}]
        out.append({
            "id": sid,
            "name": name,
            "category": cat,
            "sr": desc,
            "fdcId": int(fid),
            "srCategory": categories.get(fid),
            "per100g": {k: round(n.get(k, 0.0), 1) for k in ["kcal", "protein", "carbs", "fat", "fiber"]},
            "portions": ports,
            "flags": FLAG_OVERRIDES.get(sid, flags(f"{name} {desc}" if name in staples else name)),
        })
        print(f"{name:40s} -> {desc[:90]}", file=sys.stderr)
    for sid, name, cat, per100, ports, source in EXTRA:
        out.append({"id": sid, "name": name, "category": cat, "sr": f"label: {source}", "per100g": per100, "portions": ports, "flags": flags(name)})
    if misses:
        print(f"\nMISSES ({len(misses)}):", file=sys.stderr)
        for m in misses:
            print("  ", m, file=sys.stderr)
        sys.exit(1)
    print(f"\n{len(out)} foods", file=sys.stderr)
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
