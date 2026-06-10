/-! Lean extractor fixture — declaration shapes for the M3 inventory.
Plain test data; not meant to compile. Token shapes mirror the corpus. -/

import Mathlib.Tactic

/-- Doc comment attaches to the next declaration. -/
theorem top_theorem : 1 = 1 := rfl

lemma top_lemma' (n : Nat) : n = n := rfl

def topDef (x : Nat) : Nat := x + 1

noncomputable def hiddenDef : Nat := 0

private theorem secret_theorem : True := trivial

abbrev TopAlias := Nat

structure TopStruct where
  field1 : Nat
  field2 : Nat

inductive TopColor where
  | red
  | green

instance namedInst : Inhabited TopColor := ⟨TopColor.red⟩

instance : ToString TopColor := ⟨fun _ => "color"⟩

theorem Nat.my_extra : True := trivial

-- theorem commented_out : False := sorry

/- A block comment hiding declaration keywords:
theorem inside_block : False := sorry
inductive AlsoHidden where
-/

namespace Foo

theorem in_foo : 2 = 2 := rfl

namespace Bar

def baz : Nat := 3

end Bar

lemma after_bar : 3 = 3 := rfl

end Foo

namespace Outer

section

def inner_def : Nat := 4

end

def still_outer : Nat := 5

end Outer

section helpers

def in_section : Nat := 6

end helpers

namespace A.B

theorem dotted_ns : 4 = 4 := rfl

end A.B

def tail_def : Nat := 7
