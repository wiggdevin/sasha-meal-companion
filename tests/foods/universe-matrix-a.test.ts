// W1 acceptance 2, cuisines 1–3 of 12 (split across files so CI shards share the work).
import { describeCuisineMatrix, MATRIX_SPLIT } from "@/tests/helpers/universe-matrix";

describeCuisineMatrix(MATRIX_SPLIT[0]);
