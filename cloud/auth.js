var _ = require('underscore');

var Session = Parse.Object.extend('Session');
var User = Parse.Object.extend('User');
var Role = Parse.Object.extend('Role');

const { OrdersController } = require("./orders/orders.controller")

Parse.Cloud.define('getUserFromToken', function(req, res) {
  console.log('token: ' + req.params.sessionToken);

  var sessionQuery = new Parse.Query(Parse.Session);
  sessionQuery.equalTo('sessionToken', req.params.sessionToken);
  sessionQuery.include('user');
  var roleQuery = new Parse.Query(Parse.Role);
  roleQuery.include('users');

  var userData = {};

  sessionQuery.first({useMasterKey: true}).then(function(session) {
    userData.user = session.get('user');
    roleQuery.equalTo('users', session.get('user'));
    return roleQuery.first({useMasterKey:true});

  }).then(function(role) {
    userData.role = role;
    console.log('role: ' + role);
    res.success(userData);

  }, function(error) {
    res.error('Error: ' + error.code + ' ' + error.message);

  });
});

Parse.Cloud.define('getAllRoles', function(req, res) {

  var currentUser = {};

  var rolesQuery = new Parse.Query(Parse.Role);
  rolesQuery.include('users');

  Parse.Cloud.run('getUserFromToken', {sessionToken: req.params.sessionToken}).then(function(user) {
    currentUser = user;
    return rolesQuery.find({useMasterKey:true});

  }).then(function(roles) {
    res.success(roles);

  }, function(error) {
    res.error('Error: ' + error.code + ' ' + error.message);

  });
});

Parse.Cloud.define('getUser', function(req, res) {

  var userData = {};

  var userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('objectId', req.params.objectId);
  var roleQuery = new Parse.Query(Parse.Role);
  roleQuery.include('users');

  userQuery.first({useMasterKey:true}).then(function(user) {
    console.log('getUser - user: ' + JSON.stringify(user));
    userData.user = user;
    // Get the user's role
    roleQuery.equalTo('users', user);
    return roleQuery.first({useMasterKey:true});

  }).then(function(role) {
    console.log('getUser - role: ' + JSON.stringify(role));
    userData.role = role;
    res.success(userData);

  }, function(error) {
    res.error('Error: ' + error.code + ' ' + error.message);

  });
});

Parse.Cloud.define('updateUser', function(req, res) {

  var userData = {};

  var userQuery = new Parse.Query(Parse.User);
  userQuery.equalTo('objectId', req.params.objectId);
  var currentRoleQuery = new Parse.Query(Parse.Role);
  currentRoleQuery.include('users');
  var newRoleQuery = new Parse.Query(Parse.Role);
  newRoleQuery.equalTo('name', req.params.role);

  userQuery.first({useMasterKey:true}).then(function(user) {
    // Get the user to update
    user.set('username', req.params.username);
    user.set('email', req.params.email);
    return user.save(null, {useMasterKey:true});

  }).then(function(user) {
    console.log('cloud - user updated: ' + JSON.stringify(user));
    // Get the user's current role
    userData.user = user;
    currentRoleQuery.equalTo('users', user);
    return currentRoleQuery.first({useMasterKey:true});

  }).then(function(role) {
    console.log('cloud - current user role: ' + JSON.stringify(role));
    // Remove user from role if exists
    if (role) {
      role.getUsers().remove(userData.user);
      return role.save(null, {useMasterKey:true});
    } else {
      return true;
    }

  }).then(function() {
    // Get the new role
    return newRoleQuery.first({useMasterKey:true});

   }).then(function(role) {
     console.log('cloud - new user role: ' + JSON.stringify(role));
     // Add user to new role
     role.getUsers().add(userData.user);
     return role.save(null, {useMasterKey:true});

   }).then(function(role) {
    console.log('cloud - saved new user role: ' + JSON.stringify(role));
    userData.role = role;
    res.success(userData);

  }, function(error) {
    res.error('Error: ' + error.code + ' ' + error.message);

  });
});

Parse.Cloud.define("saveInternalNote", async function(req, res){
  
  let internalNote = req.params.internalNote;
  let orderId = req.params.orderId;
  
  if (!orderId || !internalNote) {
    res.success({status:200, success:false});
    return;
  }
  let saved = false;
  let order = await OrdersController.getOrderById(Number(orderId));
  if (order) {
    order.set('internalNotes', internalNote);
    await order.save();
    saved = true;
  }
  
  let orderInternalNotes = new Parse.Object('OrderInternalNotes');
  orderInternalNotes.set('orderId', orderId);
  orderInternalNotes.set('internalNotes', internalNote);
  orderInternalNotes.set('saved', saved);
  await orderInternalNotes.save();
  res.success({status:200, success:true})
})
