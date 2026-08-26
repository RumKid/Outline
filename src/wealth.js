(function (root) {
  function install(store, { auth, categories, accountTypes, currencies, transactionTypes, text, number, date }) {
    Object.assign(store, {
      wealth() {
        const data = this.g('pvp_wealth') || {};
        const saved = data.categories || {};
        return {
          accounts: Array.isArray(data.accounts) ? data.accounts : [],
          transactions: Array.isArray(data.transactions) ? data.transactions : [],
          budgets: data.budgets && typeof data.budgets === 'object' ? data.budgets : {},
          categories: {
            income: Array.isArray(saved.income) && saved.income.length ? saved.income : categories().income,
            expense: Array.isArray(saved.expense) && saved.expense.length ? saved.expense : categories().expense
          }
        };
      },
      _saveWealth(value) { this.s('pvp_wealth', value); },
      async addWealthAccount(accountInput) {
        const name = typeof accountInput?.name === 'string' ? accountInput.name.trim() : '';
        const balance = number(accountInput?.balance); const type = accountInput?.type || 'bank'; const currency = accountInput?.currency || '₹';
        if (!accountInput?.id || !text(name) || balance === null || !accountTypes.has(type) || !currencies.has(currency)) return false;
        const wealth = this.wealth(); const account = { ...accountInput, name, balance, type, currency };
        account.name = await auth.encryptField(account.name); wealth.accounts.push(account); this._saveWealth(wealth); return true;
      },
      async editWealthAccount(id, updates) {
        const wealth = this.wealth(); const index = wealth.accounts.findIndex(account => account.id === id);
        if (index === -1 || !updates || typeof updates !== 'object') return false;
        const next = { ...updates };
        if (next.name !== undefined) { if (!text(next.name)) return false; next.name = await auth.encryptField(next.name.trim()); }
        if (next.balance !== undefined) { next.balance = number(next.balance); if (next.balance === null) return false; }
        if (next.type !== undefined && !accountTypes.has(next.type)) return false;
        if (next.currency !== undefined && !currencies.has(next.currency)) return false;
        wealth.accounts[index] = { ...wealth.accounts[index], ...next }; this._saveWealth(wealth); return true;
      },
      delWealthAccount(id) {
        const wealth = this.wealth();
        if (!wealth.accounts.some(account => account.id === id) || wealth.transactions.some(transaction => transaction.accountId === id || transaction.toAccountId === id)) return false;
        wealth.accounts = wealth.accounts.filter(account => account.id !== id); this._saveWealth(wealth); return true;
      },
      async addWealthTransaction(input) {
        const type = input?.type; const amount = number(input?.amount); const transactionDate = input?.date;
        if (!input?.id || !transactionTypes.has(type) || amount === null || amount <= 0 || !date(transactionDate)) return false;
        const wealth = this.wealth(); const source = wealth.accounts.find(account => account.id === input.accountId);
        if (!source || number(source.balance) === null || (type === 'transfer' && (!input.toAccountId || input.toAccountId === input.accountId))) return false;
        const destination = type === 'transfer' ? wealth.accounts.find(account => account.id === input.toAccountId) : null;
        if (type === 'transfer' && (!destination || number(destination.balance) === null)) return false;
        if (!text(input.category, 80) || (input.note !== undefined && input.note !== '' && !text(input.note, 500))) return false;
        const transaction = { ...input, type, amount, date: transactionDate, category: input.category.trim() };
        if (transaction.note) transaction.note = await auth.encryptField(transaction.note.trim());
        wealth.transactions.push(transaction);
        if (type === 'income') source.balance += amount;
        else if (type === 'expense') source.balance -= amount;
        else { source.balance -= amount; destination.balance += amount; }
        this._saveWealth(wealth); return true;
      },
      delWealthTransaction(id) {
        const wealth = this.wealth(); const transaction = wealth.transactions.find(item => item.id === id); if (!transaction) return false;
        const amount = number(transaction.amount); if (amount === null || amount <= 0) return false;
        const source = wealth.accounts.find(account => account.id === transaction.accountId);
        const destination = transaction.type === 'transfer' ? wealth.accounts.find(account => account.id === transaction.toAccountId) : null;
        if (!source || number(source.balance) === null || (transaction.type === 'transfer' && (!destination || number(destination.balance) === null))) return false;
        if (transaction.type === 'income') source.balance -= amount;
        else if (transaction.type === 'expense') source.balance += amount;
        else if (transaction.type === 'transfer') { source.balance += amount; destination.balance -= amount; }
        else return false;
        wealth.transactions = wealth.transactions.filter(item => item.id !== id); this._saveWealth(wealth); return true;
      },
      setWealthBudget(category, amount) {
        const wealth = this.wealth(); const budget = number(amount);
        if (!text(category, 80) || budget === null || budget < 0 || !wealth.categories.expense.includes(category)) return false;
        wealth.budgets[category] = budget; this._saveWealth(wealth); return true;
      },
      delWealthBudget(category) {
        const wealth = this.wealth(); if (!wealth.categories.expense.includes(category)) return false;
        delete wealth.budgets[category]; this._saveWealth(wealth); return true;
      }
    });
    return store;
  }
  root.OutlineWealth = { install }; if (root !== globalThis) globalThis.OutlineWealth = root.OutlineWealth;
})(typeof window === 'object' ? window : globalThis);
