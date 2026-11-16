export const GROUPS = {
  letters: Array.from("ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی"),
  digits: Array.from("۰۱۲۳۴۵۶۷۸۹"),
  marks: Array.from("،؛؟.!:«»٪آء")
};

export const FORMS = {
  isol: "جدا",
  init: "آغاز",
  medi: "میانه",
  fina: "پایان"
};

export function formsFor(character) {
  if ("اآدذرزژو".includes(character)) return ["isol", "fina"];
  if (GROUPS.letters.includes(character)) return Object.keys(FORMS);
  return ["isol"];
}

export function drawingKey(character, form) {
  return character + "/" + form;
}

export function joins(form) {
  return {
    left: form === "init" || form === "medi",
    right: form === "fina" || form === "medi"
  };
}

export const BASELINE = 151;
export const PAPER_HEIGHT = 250;
export const PEN_WIDTH = 8.5;
export const MAX_POINTS = 1800;
