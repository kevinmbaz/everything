"""Code-owned resource allowlists; paths are logical SQLite names, never files."""
from datetime import date
import re

KV_KEYS = {
    'expense': frozenset('exp:' + k + ':v1' for k in ('settings', 'categories', 'months')),
    'time-tracking': frozenset('hourly:' + k + ':v1' for k in (
        'settings', 'clients', 'projects', 'months', 'timer', 'backups', 'invoices')),
    'tasks': frozenset('tasks:' + k + ':v1' for k in ('settings', 'lists', 'items')),
    'solitaire': frozenset(('solitaire:state:v1',)),
    'sudoku': frozenset(('sudoku:state:v1',)),
    'contacts': frozenset(('contacts:book:v1',)),
}
MONTH = r'([0-9]{4}-[0-9]{2})'
RECEIPT = re.compile(r'expenses-data/receipts/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp|heic|gif|pdf|bin)')
LOGO = re.compile(r'hourly-data/logo-[0-9]+(?:-[A-Za-z0-9_-]{1,100})?\.(?:png|jpg|webp)')


def valid_key(app, key):
    return isinstance(key, str) and key in KV_KEYS[app]


def valid_file(app, path):
    if not isinstance(path, str):
        return False
    if app == 'expense':
        if path in ('expenses-data/reports.json', 'expenses-data/statements.json') or RECEIPT.fullmatch(path):
            return True
        month = re.fullmatch(r'expenses-data/exp-' + MONTH + r'\.json', path)
    elif app == 'time-tracking':
        if LOGO.fullmatch(path):
            return True
        backup = re.fullmatch(r'hourly-data/backups/backup-([0-9]{4}-[0-9]{2}-[0-9]{2})\.json', path)
        if backup:
            try:
                date.fromisoformat(backup[1])
                return True
            except ValueError:
                return False
        month = re.fullmatch(r'hourly-data/entries-' + MONTH + r'\.json', path)
    elif app == 'tasks':
        month = re.fullmatch(r'tasks-data/log-' + MONTH + r'\.json', path)
    else:
        return False
    if month:
        try:
            date.fromisoformat(month[1] + '-01')
            return True
        except ValueError:
            pass
    return False


def valid_prefix(app, prefix):
    return (app == 'expense' and prefix == 'expenses-data/receipts/'
            or app == 'time-tracking' and prefix == 'hourly-data/backups/')
