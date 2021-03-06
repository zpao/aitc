/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["BrowserID"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-common/preferences.js");

const PREFS = new Preferences("identity.browserid.");
const ID_URI = PREFS.get("url");

/**
 * This object must be refactored into an XPCOM service at some point.
 * Bug 746398
 */
function BrowserIDService() {
  this._log = Log4Moz.repository.getLogger("Identity.BrowserID");
  this._log.level = Log4Moz.Level[PREFS.get("log")];
}
BrowserIDService.prototype = {
  /**
   * Obtain a BrowserID assertion with the specified characteristics.
   *
   * @param cb
   *        (Function) Callback to be called with (err, assertion) where 'err'
   *        can be an Error or NULL, and 'assertion' can be NULL or a valid
   *        BrowserID assertion. If no callback is provided, an exception is
   *        thrown.
   *
   * @param options
   *        (Object) An object that may contain the following properties:
   *
   *          "requiredEmail" : An email for which the assertion is to be
   *                            issued. If one could not be obtained, the call
   *                            will fail. If this property is not specified,
   *                            the default email as set by the user will be
   *                            chosen. If both this property and "sameEmailAs"
   *                            are set, an exception will be thrown.
   *
   *          "sameEmailAs"   : If set, instructs the function to issue an
   *                            assertion for the same email that was provided
   *                            to the domain specified by this value. If this
   *                            information could not be obtained, the call
   *                            will fail. If both this property and
   *                            "requiredEmail" are set, an exception will be
   *                            thrown.
   *
   *          "audience"      : The audience for which the assertion is to be
   *                            issued. If this property is not set an exception
   *                            will be thrown.
   *
   *        Any properties not listed above will be ignored.
   *
   * (This function could use some love in terms of what arguments it accepts.
   * See bug 746401.)
   */
  getAssertion: function getAssertion(cb, options) {
    if (!cb) {
      throw new Error("getAssertion called without a callback");
    }
    if (!options) {
      throw new Error("getAssertion called without any options");
    }
    if (!options.audience) {
      throw new Error("getAssertion called without an audience");
    }
    if (options.sameEmailAs && options.requiredEmail) {
      throw new Error(
        "getAssertion sameEmailAs and requiredEmail are mutually exclusive"
      );
    }

    let self = this;
    new BrowserIDSandbox(function _gotSandbox(obj) {
      self._getEmails(obj, cb, options);
    });
  },

  /**
   * Obtain a BrowserID assertion by asking the user to login and select an
   * email address.
   *
   * @param cb
   *        (Function) Callback to be called with (err, assertion) where 'err'
   *        can be an Error or NULL, and 'assertion' can be NULL or a valid
   *        BrowserID assertion. If no callback is provided, an exception is
   *        thrown.
   *
   * @param options
   *        (Object) Currently an empty object. Present for future compatiblity
   *        when options for a login case may be added. Any properties, if
   *        present, are ignored.
   *
   * @param win
   *        (Window) A contentWindow that has a valid document loaded. If this
   *        argument is provided the user will be asked to login in the context
   *        of the document currently loaded in this window.
   *        
   *        The audience of the assertion will be set to the domain of the
   *        loaded document, and the "audience" property in the "options"
   *        argument (if provided), will be ignored. The email to which this
   *        assertion issued will be selected by the user when they login (and
   *        "requiredEmail" or "sameEmailAs", if provided, will be ignored). If
   *        the user chooses to not login, this call will fail.
   *
   *        Be aware! The provided contentWindow must also have loaded the
   *        BrowserID include.js shim for this to work! This behavior is
   *        temporary until we implement native support for navigator.id.
   */
  getAssertionWithLogin: function getAssertionWithLogin(cb, options, win) {
    if (!cb) {
      throw new Error("getAssertionWithLogin called without a callback");
    }
    if (!win) {
      throw new Error("getAssertionWithLogin called without a window");
    }
    this._getAssertionWithLogin(cb, win);
  },

  // Try to get the user's email(s). If user isn't logged in, this will be empty
  _getEmails: function _getEmails(obj, cb, options) {
    let self = this;
    function callback(res) {
      let emails = {};
      try {
        emails = JSON.parse(res);
      } catch (e) {
        self._log.error("Exception in JSON.parse for _getAssertion: " + e);
      }
      self._gotEmails(emails, obj, cb, options);
    }
    obj.sandbox.importFunction(callback, "callback");
    let scriptText = 
      "var list = window.BrowserID.User.getStoredEmailKeypairs();" + 
      "callback(JSON.stringify(list));";
    Cu.evalInSandbox(scriptText, obj.sandbox, "1.8", ID_URI, 1);
  },
  
  // Received a list of emails from BrowserID for current user
  _gotEmails: function _gotEmails(emails, obj, cb, options) {
    let keys = Object.keys(emails);

    // If list is empty, user is not logged in, or doesn't have a default email.
    if (!keys.length) {
      let err = "User is not logged in, or no emails were found";
      this._log.error(err);
      cb(new Error(err), null);
      return;
    }

    // User is logged in. For which email shall we get an assertion?

    // Case 1: Explicitely provided
    if (options.requiredEmail) {
      this._getAssertionWithEmail(
        obj, cb, options.requiredEmail, options.audience
      );
      return;
    }

    // Case 2: Derive from a given domain
    if (options.sameEmailAs) {
      this._getAssertionWithDomain(
        obj, cb, options.sameEmailAs, options.audience
      );
      return;
    }

    // Case 3: Default email
    this._getAssertionWithEmail(
      obj, cb, keys[0], options.audience
    );
    return;
  },

  /**
   * Open a login window and ask the user to login, returning the assertion
   * generated as a result to the caller.
   */
  _getAssertionWithLogin: function _getAssertionWithLogin(cb, win) {
    // We're executing navigator.id.get as a content script in win.
    // This results in a popup that we will temporarily unblock.
    let pm = Services.perms;
    let origin = Services.io.newURI(
      win.wrappedJSObject.location.toString(), null, null
    );
    let oldPerm = pm.testExactPermission(origin, "popup");
    try {
      pm.add(origin, "popup", pm.ALLOW_ACTION);
    } catch(e) {}

    // Open sandbox and execute script.
    let sandbox = new Cu.Sandbox(win, {
      wantXrays:        false,
      sandboxPrototype: win
    });

    let self = this;
    function callback(val) {
      if (val) {
        self._log.info("_getAssertionWithLogin succeeded");
        cb(null, val);
      } else {
        let msg = "Could not obtain assertion in _getAssertionWithLogin";
        self._log.error(msg);
        cb(new Error(msg), null);
      }

      // Set popup blocker permission to original value.
      try {
        pm.add(origin, "popup", oldPerm);
      } catch(e) {}
    }
    sandbox.importFunction(callback, "callback");

    function doGetAssertion() {
      self._log.info("_getAssertionWithLogin Started");
      let scriptText = "window.navigator.id.get(" +
                       "  callback, {allowPersistent: true}" +
                       ");";
      Cu.evalInSandbox(scriptText, sandbox, "1.8", ID_URI, 1);
    }

    // Sometimes the provided win hasn't fully loaded yet
    let cWin = win.wrappedJSObject;
    if (!cWin.document || (cWin.document.readyState != "complete")) {
      cWin.addEventListener("DOMContentLoaded", function _contentLoaded() {
        cWin.removeEventListener("DOMContentLoaded", _contentLoaded, false);
        doGetAssertion();
      }, false);
    } else {
      doGetAssertion();
    }
  },

  /**
   * Gets an assertion for the specified 'email' and 'audience'
   */
  _getAssertionWithEmail: function _getAssertionWithEmail(obj, cb, email,
                                                          audience) {
    let self = this;

    function onSuccess(res) {
      // The internal API sometimes calls onSuccess even though no assertion
      // could be obtained! Double check:
      if (!res) {
        let msg = "BrowserID.User.getAssertion empty assertion for " + email;
        self._log.error(msg);
        cb(new Error(msg), null);
        return;
      }
      self._log.info("BrowserID.User.getAssertion succeeded");
      cb(null, res);
      obj.free();
    }
    function onError(err) {
      self._log.info("BrowserID.User.getAssertion failed");
      cb(err, null);
      obj.free();
    }
    obj.sandbox.importFunction(onSuccess, "onSuccess");
    obj.sandbox.importFunction(onError, "onError");

    self._log.info("_getAssertionWithEmail Started");
    let scriptText = 
      "window.BrowserID.User.getAssertion(" +
        "'" + email + "', "     +
        "'" + audience + "', "  +
        "onSuccess, "           +
        "onError"               +
      ");";
    Cu.evalInSandbox(scriptText, obj.sandbox, "1.8", ID_URI, 1);
  },

  /**
   * Gets the email which was used to login to 'domain'. If one was found,
   * _getAssertionWithEmail is called to obtain the assertion.
   */
  _getAssertionWithDomain: function _getAssertionWithDomain(obj, cb, domain,
                                                            audience) {
    let self = this;

    function onDomainSuccess(email) {
      if (email) {
        self._getAssertionWithEmail(obj, cb, email, audience);
      } else {
        cb(new Error("No email found for _getAssertionWithDomain"), null);
        obj.free();
      }
    }
    obj.sandbox.importFunction(onDomainSuccess, "onDomainSuccess");

    // This wil tell us which email was used to login to "domain", if any.
    self._log.info("_getAssertionWithDomain Started");
    let scriptText = 
      "onDomainSuccess(window.BrowserID.Storage.site.get(" +
        "'" + domain + "', "  +
        "'email'"             +
      "));";
    Cu.evalInSandbox(scriptText, obj.sandbox, "1.8", ID_URI, 1);
  },
};

/**
 * An object that represents a sandbox in an iframe loaded with ID_URI. The
 * callback provided to the constructor will be invoked when the sandbox is
 * ready to be used. The callback will receive this object as its only argument
 * and the prepared sandbox may be accessed via the "sandbox" property.
 *
 * Please call free() when you are finished with the sandbox to explicitely free
 * up all associated resources.
 *
 * @param cb
 *        (function) Callback to be invoked with a Sandbox, when ready.
 */
function BrowserIDSandbox(cb) {
  this._createFrame();
  this._createSandbox(cb);
}
BrowserIDSandbox.prototype = {
  /**
   * Frees the sandbox and releases the iframe created to host it.
   */
  free: function free() {
    delete this._sandbox;
    this._container.removeChild(this._frame);
    this._frame = null;
    this._container = null;
  },

  /**
   * Creates an empty, hidden iframe and sets it to the _iframe
   * property of this object.
   *
   * @return frame
   *         (iframe) An empty, hidden iframe
   */
  _createFrame: function _createFrame() {
    // TODO: What if there is no most recent browser window? (bug 745415).
    let doc = Services.wm.getMostRecentWindow("navigator:browser").document;

    // Insert iframe in to create docshell.
    let frame = doc.createElement("iframe");
    frame.setAttribute("type", "content");
    frame.setAttribute("collapsed", "true");
    doc.documentElement.appendChild(frame);

    // Stop about:blank from being loaded.
    let webNav = frame.docShell.QueryInterface(Ci.nsIWebNavigation);
    webNav.stop(Ci.nsIWebNavigation.STOP_NETWORK);

    // Set instance properties.
    this._frame = frame;
    this._container = doc.documentElement;
  },
  
  _createSandbox: function _createSandbox(cb) {
    let self = this;
    this._frame.addEventListener(
      "DOMContentLoaded",
      function _makeSandboxContentLoaded(event) {
        if (event.target.location.toString() != ID_URI) {
          return;
        }
        event.target.removeEventListener(
          "DOMContentLoaded", _makeSandboxContentLoaded, false
        );
        let workerWindow = self._frame.contentWindow;
        self.sandbox = new Cu.Sandbox(workerWindow, {
          wantXrays:        false,
          sandboxPrototype: workerWindow
        });
        cb(self);
      },
      true
    );

    // Load the iframe.
    this._frame.docShell.loadURI(
      ID_URI,
      this._frame.docShell.LOAD_FLAGS_NONE,
      null, // referrer
      null, // postData
      null  // headers
    );
  },
};

XPCOMUtils.defineLazyGetter(this, "BrowserID", function() {
  return new BrowserIDService();
});