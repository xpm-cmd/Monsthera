// Phase 1 TextMate extractor fixture — JavaScript declarations.
// Plain test data; not meant to be a runnable program.

export function greet(name) {
  return "hi " + name;
}

async function loadData() {
  return Promise.resolve([]);
}

class Account {
  constructor(id) {
    this.id = id;
  }

  describe() {
    return "account-" + this.id;
  }
}

const arrowAdd = (a, b) => a + b;
const arrowMul = function multiply(a, b) {
  return a * b;
};

export { arrowAdd };
