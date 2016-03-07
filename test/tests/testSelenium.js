var assert = require('assert');
var fs = require('fs');
var path = require('path');
var fse = require('fs-extra');
var temp = require('temp').track();
var colors = require('colors');

if (!process.env.GCM_API_KEY) {
  console.log('You need to set the GCM_API_KEY env variable to run these tests.'.bold.red);
  return;
}

var firefoxBinaryPath = process.env.FIREFOX;
if (!firefoxBinaryPath) {
  if (process.platform === 'linux') {
    firefoxBinaryPath = 'test_tools/firefox/firefox-bin';
  } else if (process.platform === 'darwin') {
    firefoxBinaryPath = 'test_tools/FirefoxNightly.app/Contents/MacOS/firefox-bin';
  }
}
if (!fs.existsSync(firefoxBinaryPath)) {
  throw new Error('Firefox binary doesn\'t exist at ' + firefoxBinaryPath + '. Use your installed Firefox binary by setting the FIREFOX environment'.bold.red);
}

var chromeBinaryPath = process.env.CHROME;
if (!chromeBinaryPath) {
  if (process.platform === 'linux') {
    chromeBinaryPath = 'test_tools/chrome-linux/chrome';
  } else if (process.platform === 'darwin') {
    chromeBinaryPath = 'test_tools/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
  }
}
if (!fs.existsSync(chromeBinaryPath)) {
  throw new Error('Chrome binary doesn\'t exist at ' + chromeBinaryPath + '. Use your installed Chrome binary by setting the CHROME environment'.bold.red);
}

process.env.PATH = process.env.PATH + ':test_tools/';

var pageLoaded = false;
var clientRegistered = 0;

var createServer = require('../../demo/server');

var server;
function startServer(pushPayload, pushTimeout) {
  server = createServer(pushPayload, pushTimeout ? pushTimeout : 0);

  pageLoaded = false;
  clientRegistered = 0;
  server.onClientRegistered = function() {
    pageLoaded = true;
    clientRegistered++;
    return clientRegistered > 1;
  }
}

var webdriver = require('selenium-webdriver'),
    By = require('selenium-webdriver').By,
    until = require('selenium-webdriver').until;

var firefox = require('selenium-webdriver/firefox');
var chrome = require('selenium-webdriver/chrome');

var profilePath = temp.mkdirSync('marco');

var driver;

function startBrowser() {
  var profile = new firefox.Profile(profilePath);
  profile.acceptUntrustedCerts();
  profile.setPreference('security.turn_off_all_security_so_that_viruses_can_take_over_this_computer', true);
  profile.setPreference('extensions.checkCompatibility.nightly', false);
  // Only allow installation of third-party addons from the user's profile dir (needed to block the third-party
  // installation prompt for the Ubuntu Modifications addon on Ubuntu).
  profile.setPreference('extensions.enabledScopes', 1);
  //profile.setPreference('dom.push.debug', true);
  //profile.setPreference('browser.dom.window.dump.enabled', true);

  var firefoxBinary = new firefox.Binary(firefoxBinaryPath);

  var firefoxOptions = new firefox.Options().setProfile(profile).setBinary(firefoxBinary);

  var chromeOptions = new chrome.Options()
    .setChromeBinaryPath(chromeBinaryPath)
    .addArguments('--no-sandbox')
    .addArguments('user-data-dir=' + profilePath);

  var builder = new webdriver.Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(firefoxOptions)
    .setChromeOptions(chromeOptions);
  var driver = builder.build();

  driver.wait(function() {
    return server.listening;
  });
  driver.executeScript(function() {
    if (typeof netscape !== 'undefined') {
      netscape.security.PrivilegeManager.enablePrivilege('UniversalXPConnect');
      Components.utils.import('resource://gre/modules/Services.jsm');
      var uri = Services.io.newURI('https://127.0.0.1:50005', null, null);
      var principal = Services.scriptSecurityManager.getNoAppCodebasePrincipal(uri);
      Services.perms.addFromPrincipal(principal, 'desktop-notification', Services.perms.ALLOW_ACTION);
    }
  });
  /*
  This currently doesn't work in Firefox Nightly.
  driver.get('https://127.0.0.1:50005');
  */
  driver.executeScript(function() {
    window.location = 'https://127.0.0.1:50005';
  });
  driver.wait(function() {
    return pageLoaded;
  });

  return driver;
}

function checkEnd(driver, pushPayload) {
  return driver.wait(until.titleIs(pushPayload ? pushPayload : 'no payload'), 60000);
}

function noRestartTest(browser, pushPayload, pushTimeout) {
  process.env.SELENIUM_BROWSER = browser;

  startServer(pushPayload, pushTimeout);

  driver = startBrowser();

  return checkEnd(driver, pushPayload)
}

function restartTest(browser, pushPayload, pushTimeout) {
  return new Promise(function(resolve, reject) {
    process.env.SELENIUM_BROWSER = browser;

    startServer(pushPayload, pushTimeout);

    driver = startBrowser();

    function restart() {
      console.log('Browser - Restart');
      driver = startBrowser();
      checkEnd(driver, pushPayload)
      .then(resolve);
    }

    driver.close()
    .then(function() {
      console.log('Browser - Closed');

      pageLoaded = false;

      setTimeout(function() {
        try {
          // In Firefox, we need to copy the storage directory (because the PushDB is
          // stored in an IndexedDB) and the prefs.js file, which contains a preference
          // (dom.push.userAgentID) storing the User Agent ID.
          // We need to wait a bit before copying these files because Firefox updates
          // some of them when shutting down.
          [ 'storage', 'prefs.js', 'serviceworker.txt' ].forEach(function(file) {
            fse.copySync(path.join(driver.profilePath_, file), path.join(profilePath, file));
          });
        } catch (e) {
          console.log('Error while copying: ' + e);
        }

        if (server.notificationSent) {
          restart();
        } else {
          server.onNotificationSent = function() {
            server.onNotificationSent = null;
            restart();
          };
        }
      }, 1000);
    });
  });
}

suite('selenium', function() {
  this.timeout(0);

  teardown(function(done) {
    driver.quit()
    .then(function() {
      server.close(done);
    });
  });

  test('send/receive notification without payload with Firefox', function() {
    return noRestartTest('firefox');
  });

  if (process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification without payload with Chrome', function() {
      return noRestartTest('chrome');
    });
  }

  test('send/receive notification with payload with Firefox', function() {
    return noRestartTest('firefox', 'marco');
  });

  /*
  if (process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification with payload with Chrome', function() {
      return noRestartTest('chrome', 'marco');
    });
  }*/

  test('send/receive notification without payload with TTL with Firefox (closing and restarting the browser)', function() {
    return restartTest('firefox', undefined, 2);
  });

  if (process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification without payload with TTL with Chrome (closing and restarting the browser)', function() {
      return restartTest('chrome', undefined, 2);
    });
  }

  test('send/receive notification with payload with TTL with Firefox (closing and restarting the browser)', function() {
    return restartTest('firefox', 'marco', 2);
  });

  /*
  if (process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification with payload with TTL with Chrome (closing and restarting the browser)', function() {
      return restartTest('chrome', 'marco', 2);
    });
  }*/
});
