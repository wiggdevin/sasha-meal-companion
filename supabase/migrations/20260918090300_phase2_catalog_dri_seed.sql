-- catalog_dri references catalog_nutrients(code), and Lane F fills catalog_nutrients from a worker,
-- not a migration. Seed the twenty canonical codes of Phase 1–2 contracts §2 so this file applies on
-- an empty catalog (a preview branch, production before the first import). Lane F's import upserts
-- the same codes and wins on name/fdc id.
insert into catalog_nutrients (code, name, unit, derivation) values
  ('energy_kcal','Energy','kcal','measured'), ('energy_kcal_calc','Energy (Atwater)','kcal','calculated'),
  ('protein','Protein','g','measured'), ('carbohydrate','Carbohydrate, by difference','g','measured'),
  ('fat_total','Total lipid (fat)','g','measured'), ('fiber_total','Fiber, total dietary','g','measured'),
  ('sugars_total','Sugars, total','g','measured'), ('sodium','Sodium','mg','measured'),
  ('potassium','Potassium','mg','measured'), ('calcium','Calcium','mg','measured'),
  ('iron','Iron','mg','measured'), ('magnesium','Magnesium','mg','measured'), ('zinc','Zinc','mg','measured'),
  ('vitamin_c','Vitamin C, total ascorbic acid','mg','measured'), ('vitamin_d','Vitamin D (D2 + D3)','µg','measured'),
  ('vitamin_b12','Vitamin B-12','µg','measured'), ('folate_dfe','Folate, DFE','µg','measured'),
  ('vitamin_a_rae','Vitamin A, RAE','µg','measured'), ('saturated_fat','Fatty acids, total saturated','g','measured'),
  ('cholesterol','Cholesterol','mg','measured')
on conflict (code) do nothing;

-- Reference values for the tracked micro set, female 19–30, NASEM DRI tables. The unique key
-- makes `on conflict do nothing` mean something on a branch reset; without it the spec's
-- conflict clause matches no constraint and a re-run duplicates every row.
create unique index if not exists catalog_dri_key on catalog_dri
  (nutrient_code, authority, ref_type, sex, age_min, age_max, life_stage);

insert into catalog_dri (nutrient_code, authority, ref_type, sex, age_min, age_max,
                         life_stage, value, unit, effective_date) values
  ('fiber_total','NASEM','AI','female',19,30,'none',25,'g','2005-01-01'),
  ('iron','NASEM','RDA','female',19,30,'none',18,'mg','2001-01-01'),
  ('calcium','NASEM','RDA','female',19,30,'none',1000,'mg','2011-01-01'),
  ('potassium','NASEM','AI','female',19,30,'none',2600,'mg','2019-01-01'),
  ('magnesium','NASEM','RDA','female',19,30,'none',310,'mg','1997-01-01'),
  ('zinc','NASEM','RDA','female',19,30,'none',8,'mg','2001-01-01'),
  ('vitamin_c','NASEM','RDA','female',19,30,'none',75,'mg','2000-01-01'),
  ('vitamin_d','NASEM','RDA','female',19,30,'none',15,'µg','2011-01-01'),
  ('vitamin_b12','NASEM','RDA','female',19,30,'none',2.4,'µg','1998-01-01'),
  ('folate_dfe','NASEM','RDA','female',19,30,'none',400,'µg','1998-01-01'),
  ('vitamin_a_rae','NASEM','RDA','female',19,30,'none',700,'µg','2001-01-01'),
  ('sodium','NASEM','AI','female',19,30,'none',1500,'mg','2019-01-01')
on conflict do nothing;

-- Fiber is seeded for export and for later users, and is NOT shown against the DRI on her screen:
-- targets.md sets her band at 20–25 g/day, soluble-dominant, below the 25 g AI. The band wins.
