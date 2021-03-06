const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const plist = require('plist');
const deepAssign = require('deep-assign');
const is = require('is_js');
const { PLUGIN_PATH } = require('../../utils/paths');
const CacheConf = require('../../utils/CacheConf');

/**
 * Loads plugins in the given path
 *
 * @param {String} directory - The directory to read
 * @return {Promise} - An array of plugin paths
 */
exports.loadPluginsInPath = directory => new Promise(resolve => {
  const loaded = [];
  fs.readdir(directory, (err, plugins) => {
    if (plugins && plugins.length) {
      plugins.forEach(plugin => {
        if (plugin !== '.DS_Store') {
          const pluginPath = path.resolve(directory, plugin);
          loaded.push(pluginPath);
        }
      });
    }
    resolve(loaded);
  });
});

exports.isCorePlugin = directory => {
  const dirname = path.dirname(directory);
  if (dirname === PLUGIN_PATH) {
    return false;
  }
  return true;
};

/**
 * Checks if the plugin is a theme
 *
 * @param {String} directory - A plugin directory
 * @return {Boolean} - True if it is a theme
 */
exports.isPluginATheme = directory => {
  try {
    const pkg = require(path.resolve(directory, 'package.json')); // eslint-disable-line global-require
    // TODO: change the mechanism?
    // don't load themes by checking if dext-theme is non-existent in keywords
    if (!pkg.keywords || pkg.keywords.indexOf('dext-theme') > -1) {
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
};

/**
 * Applies the module properties by loading them.
 * Loads the plugin's Alfred plist file if available.
 * Modifies the schema property if the plugin is an Alfred plugin.
 *
 * { path, name, isCore, schema, action, keyword }
 *
 * @param {String} plugin - The plugin object
 * @return {Promise} - A modified clone of the plugin object
 */
exports.applyModuleProperties = plugin => new Promise(resolve => {
  const plistPath = path.resolve(plugin.path, 'info.plist');
  fs.access(plistPath, fs.constants.R_OK, err1 => {
    if (err1) {
      // retrieve the keyword and action from the plugin
      // eslint-disable-next-line global-require
      const { keyword, action } = require(plugin.path);
      // set the plugin object overrides
      const newOpts = {
        schema: 'dext',
        action,
        keyword,
      };
      resolve(deepAssign({}, plugin, newOpts));
    } else {
      // read the plist file
      fs.readFile(plistPath, 'utf8', (err2, data) => {
        if (err2) {
          resolve(plugin);
        } else {
          // parse the plist
          const plistData = plist.parse(data);
          let keyword = '';
          let action = '';
          plistData.objects.forEach(o => {
            if (o.type === 'alfred.workflow.input.scriptfilter') {
              keyword = o.config.keyword;
            } else if (o.type === 'alfred.workflow.action.openurl') {
              action = 'openurl';
            }
          });
          // set the plugin object overrides
          const newOpts = {
            schema: 'alfred',
            action,
            keyword,
          };
          resolve(deepAssign({}, plugin, newOpts));
        }
      });
    }
  });
});

/**
 * Connects the item sets with the given plugin
 *
 * plugin { path, name, isCore, schema, action, keyword }
 *
 * @param {Object[]} items - An array of items
 * @param {Object} plugin - The plugin object data
 * @return {Object}
 */
exports.connectItems = (items, plugin) => items.map(i => {
  const icon = {
    path: '',
  };
  if (i.icon && i.icon.path) {
    icon.path = i.icon.path;
    // resolve non-urls
    if (!is.url(i.icon.path)) {
      icon.path = path.resolve(plugin.path, i.icon.path);
    }
  }
  const newObject = deepAssign({}, i);
  if (plugin.keyword) {
    newObject.keyword = plugin.keyword;
  }
  if (plugin.action) {
    newObject.action = plugin.action;
  }
  if (icon.path) {
    newObject.icon.path = icon.path;
  }
  return newObject;
});

/**
 * Queries for the items in the given plugin
 *
 * plugins { path, name, isCore, schema, action, keyword }
 *
 * @param {Object} - The plugin object
 * @param {String[]} - An array of arguments
 * @return {Promise} - An array of results
 */
exports.queryResults = (plugin, args) => new Promise(resolve => {
  // load from cache
  const cacheConf = new CacheConf({ configName: path.basename(plugin.path) });
  const q = args.join(' ');
  const cacheKey = q;
  // if (cacheConf.has(cacheKey)) {
  //   const cachedResults = cacheConf.get(cacheKey);
  //   resolve(cachedResults);
  //   return;
  // }
  // process based on the schema
  switch (plugin.schema) {
    case 'alfred': {
      // fork a child process to receive all stdout
      // and concat it to the results array
      const options = {
        cwd: plugin.path,
        silent: true,
      };
      const child = fork(plugin.path, args, options);
      let msg = '';
      child.stdout.on('data', data => {
        if (data) {
          msg += data.toString();
        }
      });
      child.on('exit', () => {
        let items = [];
        if (msg.length) {
          const output = JSON.parse(msg);
          if (output) {
            items = exports.connectItems(output.items, plugin);
          }
        }
        cacheConf.set(cacheKey, items);
        resolve(items);
      });
      break;
    }
    case 'dext':
      // no break
    default: { // eslint-disable-line no-fallthrough
      const m = require(plugin.path); // eslint-disable-line global-require
      let output = '';
      if (typeof m.execute === 'function') {
        output = m.execute(q);
      } else {
        output = m.execute;
      }
      let items = [];
      if (output) {
        Promise.resolve(output).then(i => {
          items = exports.connectItems(i.items, plugin);
          cacheConf.set(cacheKey, items);
          resolve(items);
        });
      } else {
        resolve([]);
      }
      break;
    }
  }
});
