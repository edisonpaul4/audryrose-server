var _ = require('underscore');
var moment = require('moment-timezone');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");
var Mailgun = require('mailgun-js');

var Product = Parse.Object.extend('Product');
var Designer = Parse.Object.extend('Designer');
var Vendor = Parse.Object.extend('Vendor');
var VendorOrder = Parse.Object.extend('VendorOrder');
var VendorOrderVariant = Parse.Object.extend('VendorOrderVariant');

// CONFIG
bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
var mailgun = new Mailgun({apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN});
const BIGCOMMERCE_BATCH_SIZE = 250;
const DESIGNERS_PER_PAGE = 50;
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getDesigners", function(request, response) {
  logInfo('getDesigners cloud function --------------------------', true);
  var totalDesigners;
  var designers;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'name-asc';
  var subpage = request.params.subpage ? request.params.subpage : 'all';
  var search = request.params.search ? request.params.search : null;
  
  var designersQuery = new Parse.Query(Designer);
  
  if (search) {
    var searchDesignerIdQuery = new Parse.Query(Designer);
    searchDesignerIdQuery.equalTo('designerId', parseFloat(search)); 
    designersQuery = searchDesignerIdQuery;
    
  } else {
    designersQuery = getDesignerSort(designersQuery, currentSort);
    switch (subpage) {
      case 'pending':
        designersQuery.equalTo('hasPendingVendorOrder', true);
        break; 
      case 'sent':
        designersQuery.equalTo('hasSentVendorOrder', true);
        break; 
    }
  }
  
  designersQuery.limit(10000);
  designersQuery.include('vendors');
  designersQuery.include('vendors.vendorOrders');
  designersQuery.include('vendors.vendorOrders.vendorOrderVariants');
  designersQuery.include('vendors.vendorOrders.vendorOrderVariants.orderProducts');
  designersQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
  designersQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
  
  designersQuery.count().then(function(count) {
    totalDesigners = count;
    totalPages = Math.ceil(totalDesigners / 10000);
    designersQuery.skip((currentPage - 1) * 10000);
    return designersQuery.find({useMasterKey:true});
    
  }).then(function(results) {
    designers = results;
    
	  response.success({designers: designers, totalPages: totalPages});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("loadDesigner", function(request, response) {
  logInfo('loadDesigner cloud function --------------------------', true);
  var designer = request.params.designer;
  var designerObj;
  var added = false;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('designerId', parseInt(designer.id));
  designerQuery.include('vendor');
  designerQuery.first().then(function(designerResult) {
    if (designerResult) {
      logInfo('designer ' + designerResult.get('designerId') + ' exists.');
      return createDesignerObject(designer, designerResult).save(null, {useMasterKey: true});
    } else {
      logInfo('designer ' + designer.id + ' is new.');
      added = true;
      return createDesignerObject(designer).save(null, {useMasterKey: true});
    }
    
  }).then(function(designerObject) {
    designerObj = designerObject;
    
    if (designerObject.has('vendors')) {
      logInfo('Designer has a vendor');
      return designerObject.get('vendors');
      
    } else if (designerObject.get('designerId') == 47) {
      logInfo('Designer is Antiques and has multiple vendors');
      return [];
      
    } else {
      logInfo('Designer is self vendor');
      var vendor = new Vendor();
      vendor.set('name', designerObject.get('name'));
      vendor.set('designers', [designerObject]);
      return [vendor];
    }
    
  }).then(function(vendors) {
      designerObj.set('vendors', vendors);
      return designerObj.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    response.success({added: added});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
		
	});
});

Parse.Cloud.define("saveVendor", function(request, response) {
  logInfo('saveVendor cloud function --------------------------', true);
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var designerId = request.params.data.designerId;
  var vendorId = request.params.data.vendorId;
  var name = request.params.data.name;
  var firstName = request.params.data.firstName;
  var lastName = request.params.data.lastName;
  var email = request.params.data.email;
  var waitTime = parseFloat(request.params.data.waitTime);
  var designer;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', designerId);
  designerQuery.include('vendors');
  designerQuery.first().then(function(result) {
    designer = result;
    
    if (vendorId) {
      var vendorQuery = new Parse.Query(Vendor);
      vendorQuery.equalTo('objectId', vendorId);
      vendorQuery.include('designers');
      return vendorQuery.first();
    } else {
      var vendor = new Vendor();
      return vendor.save(null, {useMasterKey: true});
    }
    
  }).then(function(vendor) {
    
    if (name && name != '') {
      vendor.set('name', name);
    } else {
      vendor.unset('name');
    }
    if (firstName && firstName != '') {
      vendor.set('firstName', firstName);
    } else {
      vendor.unset('firstName');
    }
    if (lastName && lastName != '') {
      vendor.set('lastName', lastName);
    } else {
      vendor.unset('lastName');
    }
    if (email && email != '') {
      vendor.set('email', email);
    } else {
      vendor.unset('email');
    }
    if (waitTime && waitTime != '') {
      vendor.set('waitTime', waitTime);
    } else {
      vendor.unset('waitTime');
    }
    
    if (vendor.has('designers')) {
      vendor.addUnique('designers', designer);
    } else {
      vendor.set('designers', [designer]);
    }
    
    return vendor.save(null, {useMasterKey: true});
    
    
  }).then(function(vendorObject) {
    
    if (designer.has('vendors')) {
      designer.addUnique('vendors', vendorObject);
    } else {
      designer.set('vendors', [vendorObject]);
    }
    
    return designer.save(null, {useMasterKey: true});
    
  }).then(function(designerObject) {
    
    designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.orderProducts');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();
    
  }).then(function(designerObject) {
    completed = true;
    response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});

Parse.Cloud.define("saveVendorOrder", function(request, response) {
  logInfo('saveVendorOrder cloud function --------------------------', true);
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var variantsData = request.params.data.variantsData;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants = [];
  var vendor;
  var numReceived = 0;
  var productIds = [];
  
  logInfo('saveVendorOrder #' + orderId + ' ---------------------');
  
  var vendorOrderQuery = new Parse.Query(VendorOrder);
  vendorOrderQuery.equalTo('objectId', orderId);
  vendorOrderQuery.include('vendor');
  vendorOrderQuery.include('vendor.vendorOrders');
  vendorOrderQuery.first().then(function(result) {
    vendorOrder = result;
    vendor = vendorOrder.get('vendor');
    
    var promise = Parse.Promise.as();
    
    _.each(variantsData, function(variantData) {
      var variant;
      promise = promise.then(function() {
        var vendorOrderVariantQuery = new Parse.Query(VendorOrderVariant);
        vendorOrderVariantQuery.equalTo('objectId', variantData.objectId);
        vendorOrderVariantQuery.include('variant');
        vendorOrderVariantQuery.include('resizeVariant');
        vendorOrderVariantQuery.include('orderProducts');
        vendorOrderVariantQuery.include('orderProducts.vendorOrders');
        vendorOrderVariantQuery.include('orderProducts.awaitingInventory');
        vendorOrderVariantQuery.include('orderProducts.awaitingInventoryVendorOrders');
        return vendorOrderVariantQuery.first();
        
      }).then(function(vendorOrderVariant) {
        if (vendorOrderVariant) {
          variant = vendorOrderVariant.get('variant');
          logInfo('VendorOrderVariant found, set to ' + parseFloat(variantData.units) + ' units');
          if (variantData.units != undefined) vendorOrderVariant.set('units', parseFloat(variantData.units));
          if (variantData.notes != undefined) vendorOrderVariant.set('notes', variantData.notes);
          if (variantData.received != undefined) {
            logInfo('received:' + parseFloat(variantData.received))
            if (parseFloat(variantData.received) > vendorOrderVariant.get('received')) {
              var inventoryDiff = parseFloat(variantData.received) - vendorOrderVariant.get('received');
              var totalReserved = 0;
              if (vendorOrderVariant.get('orderProducts') && vendorOrderVariant.get('orderProducts').length > 0) {
                _.each(vendorOrderVariant.get('orderProducts'), function(orderProduct) {
                  var need = orderProduct.get('quantity') - orderProduct.get('quantity_shipped');
                  var reservable = inventoryDiff > 0 ? inventoryDiff : 0;
                  logInfo('need:' + need + ' reservable:' + reservable);
                  if (need > 0 && reservable > 0) totalReserved += reservable > need ? need : reservable;
                });
                var inventoryNotReserved = totalReserved < inventoryDiff ? inventoryDiff - totalReserved : 0;
                logInfo('totalReserved: ' + totalReserved + 'inventoryNotReserved: ' + inventoryNotReserved);
                logInfo('add ' + inventoryNotReserved + ' to variant inventory');
                variant.increment('inventoryLevel', inventoryNotReserved);
              } else {
                logInfo('add ' + inventoryDiff + ' to variant inventory');
                variant.increment('inventoryLevel', inventoryDiff); 
              }
              logInfo('Set inventory for variant ' + variant.get('variantId') + ' to ' + variant.get('inventoryLevel'), true);
            }
            vendorOrderVariant.set('received', parseFloat(variantData.received));
            if (vendorOrderVariant.get('received') >= vendorOrderVariant.get('units')) {
              vendorOrderVariant.set('done', true);
            }
          }
//           vendorOrderVariant.set('vendorOrder', vendorOrder);
          return vendorOrderVariant.save(null, {useMasterKey:true});
        } else {
          logInfo('VendorOrderVariant not found');
          return;
        }
        
      }).then(function(vendorOrderVariant) {
        if (vendorOrderVariant && vendorOrderVariant.has('units')) {
          logInfo('VendorOrderVariant saved');
          logInfo('Variant has ' + vendorOrderVariant.get('units') + ' units');
          vendorOrderVariants.push(vendorOrderVariant);
          
          if (vendorOrderVariant.get('ordered') == true && vendorOrderVariant.get('received') >= vendorOrderVariant.get('units')) {
            numReceived++;
          }
        } else {
          logInfo('VendorOrderVariant not saved');
        }
        
        if (variant) {
          if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
          return variant.save(null, {useMasterKey:true});
        } else {
          return;
        }
      }).then(function(result) {
        logInfo('ProductVariant saved');
        
      }, function(error) {
        logError(error);
      });
    });
    
    return promise;
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	}).then(function() {
    vendorOrder.set('vendorOrderVariants', vendorOrderVariants);
    var totalWithUnits = 0;
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      if (vendorOrderVariant.get('units') > 0) totalWithUnits++;
    });
    logInfo('Total ' + vendorOrderVariants.length + ' vendorOrderVariants, ' + totalWithUnits + ' are requesting units');
    if (totalWithUnits > 0) {
      logInfo('Save changes to vendor order');
      vendorOrder.set('message', message);
      if (numReceived >= vendorOrderVariants.length) {
        vendorOrder.set('receivedAll', true);
        vendorOrder.set('dateReceived', moment().toDate());
        vendor.remove('vendorOrders', vendorOrder);
      }
      return vendorOrder.save(null, {useMasterKey:true});
    } else {
      logInfo('All variants removed, destroy the vendor order');
      vendor.remove('vendorOrders', vendorOrder);
      return destroyVendorOrder(vendorOrder);
    }
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	}).then(function() {
    return vendor.save(null, {useMasterKey:true})
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	}).then(function() {
    logInfo('vendor saved');
  	logInfo(productIds.length + ' product ids to save');
  	
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);
      
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        return productQuery.first();
      
      }).then(function(product) {
        return product.save(null, {useMasterKey: true});
        
      }).then(function() {
        return;
        
      }, function(error) {
    		logError(error);
    		
    	});
  	});
  	
  	return promise;
  	
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	}).then(function(result) {
    logInfo('products saved');
    return Parse.Cloud.run('updateAwaitingInventoryQueue');
    
  }).then(function(result) {
    
    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	}).then(function(designerObject) {
  	completed = true;
    response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});

Parse.Cloud.define("sendVendorOrder", function(request, response) {
  logInfo('sendVendorOrder cloud function --------------------------', true);
  
  var completed = false;
  setTimeout(function() {
    if (!completed) response.success({timeout: 'Your request is still processing, please reload the page.'});
  }, 20000);
  
  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants;
  var vendor;
  var resizeVariants = [];
  var messageProductsText = message;
  var messageProductsHTML = message;
  var emailId;
  var productIds = [];
  var successMessage;
  var errors = [];
   
  var vendorOrderQuery = new Parse.Query(VendorOrder);
  vendorOrderQuery.equalTo('objectId', orderId);
  vendorOrderQuery.include('vendor');
  vendorOrderQuery.include('vendorOrderVariants');
  vendorOrderQuery.include('vendorOrderVariants.variant');
  vendorOrderQuery.include('vendorOrderVariants.resizeVariant');
  vendorOrderQuery.first().then(function(result) {
    if (result) {
      vendorOrder = result;
    } else {
      errors.push('Error sending order: vendor order not found.');
      response.success({errors: errors});
      return;
    }
    vendor = vendorOrder.get('vendor');
    vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
    
    if (vendorOrder.get('orderedAll') == true) {
      errors.push('Error sending order: order already sent.');
      response.success({errors: errors});
      return;
    }
    
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      vendorOrderVariant.set('ordered', true);
      var variant = vendorOrderVariant.get('variant');
      if (vendorOrderVariant.get('isResize') == true) {
        var resizeVariant = vendorOrderVariant.get('resizeVariant');
        var subtractForResize = parseFloat(vendorOrderVariant.get('units')) * -1;
        resizeVariant.increment('inventoryLevel', subtractForResize);
        logInfo('Set inventory for variant ' + resizeVariant.get('variantId') + ' to ' + resizeVariant.get('inventoryLevel'), true);
        resizeVariants.push(resizeVariant);
      }
      if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
    });
    messageProductsHTML = convertVendorOrderMessage(messageProductsHTML, vendorOrderVariants);
    
    if (!vendor.has('email')) {
      errors.push('Error sending order: ' + vendor.get('name') + ' needs an email address.');
      response.success({errors: errors});
      return;
    }
    var data = {
      from: 'orders@loveaudryrose.com',
      to: vendor.get('name') + ' <' + vendor.get('email') + '>',
      cc: 'Audry Rose <orders@loveaudryrose.com>',
      bcc: 'male@jeremyadam.com',
      subject: 'Audry Rose Order ' + vendorOrder.get('vendorOrderNumber') + ' - ' + moment().tz('America/Los_Angeles').format('M.D.YY'),
      text: messageProductsText,
      html: messageProductsHTML
    }
    return mailgun.messages().send(data);
    
  }).then(function(body) {
    emailId = body.id;
    successMessage = 'Order ' + vendorOrder.get('vendorOrderNumber') + ' successfully sent to ' + vendor.get('email');
    logInfo(successMessage, true);
    
    return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});
    
  }).then(function() {
    logInfo(vendorOrderVariants.length + ' vendorOrderVariants saved');
    vendorOrder.set('orderedAll', true);
    vendorOrder.set('emailId', emailId);
    vendorOrder.set('dateOrdered', moment().toDate());
    return vendorOrder.save(null, {useMasterKey: true});
    
  }).then(function() {
    logInfo('vendorOrder saved');
    vendor.addUnique('vendorOrders', vendorOrder);
    return vendor.save(null, {useMasterKey: true});
    
  }).then(function() {
    logInfo('vendor saved');
    
  	logInfo(resizeVariants.length + ' resize variants to save');
  	return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});
  	
	}).then(function() {
    logInfo(resizeVariants.length + ' resize variants saved');
    
    logInfo(productIds.length + ' product ids to save');
  	
    var promise = Parse.Promise.as();
    
    _.each(productIds, function(productId) {
      logInfo('get product id: ' + productId);
      
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', productId);
        return productQuery.first();
      
      }).then(function(product) {
        return product.save(null, {useMasterKey: true});
        
      }).then(function() {
        return;
        
      }, function(error) {
    		logError(error);
    		
    	});
  	});
  	
  	return promise;
  	
  }).then(function(result) {
    logInfo('products saved');
    return Parse.Cloud.run('updateAwaitingInventoryQueue');
    
  }).then(function(result) {
    
    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.resizeVariant');
    return designerQuery.first();
    
  }).then(function(designerObject) {
    logInfo('sendVendorOrder complete');
    completed = true;
    response.success({updatedDesigner: designerObject, successMessage: successMessage, errors: errors});
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});


/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Vendor", function(request, response) {
  logInfo('Vendor beforeSave --------------------------', true);
  var vendor = request.object;
  var hasPendingVendorOrder = false;
  var hasSentVendorOrder = false;
  
  if (!vendor.has('abbreviation')) {
    var abbreviation = getAbbreviation(vendor.get('name'));
    vendor.set('abbreviation', abbreviation);
  }
    
  delay(10).then(function() {
    if (vendor.has('vendorOrders') && vendor.get('vendorOrders').length > 0) {
      return Parse.Object.fetchAll(vendor.get('vendorOrders'));
    } else {
      return [];
    }
    
  }).then(function(vendorOrders) {
    logInfo('vendor has ' + vendorOrders.length + ' vendor orders');
    _.each(vendorOrders, function(vendorOrder) {
      var orderedAll = vendorOrder.get('orderedAll');
      var receivedAll = vendorOrder.get('receivedAll');
      if (!orderedAll) {
        hasPendingVendorOrder = true;
      } else if (orderedAll && !receivedAll) {
        hasSentVendorOrder = true;
      }
    });
    logInfo('Vendor hasPendingVendorOrder: ' + hasPendingVendorOrder);
    logInfo('Vendor hasSentVendorOrder: ' + hasSentVendorOrder);
    
    if (vendor.has('designers') && vendor.get('designers').length > 0) {
      return Parse.Object.fetchAll(vendor.get('designers'));
    } else {
      return [];
    }
    
  }).then(function(designers) {
    logInfo('vendor has ' + designers.length + ' vendor orders');
    _.each(designers, function(designer) {
      designer.set('hasPendingVendorOrder', hasPendingVendorOrder);
      designer.set('hasSentVendorOrder', hasSentVendorOrder);
    });
    if (designers.length > 0) {
      return Parse.Object.saveAll(designers, {useMasterKey: true});
    } else {
      return [];
    }
    
  }).then(function() {
    logInfo('Vendor beforeSave complete');
    response.success();
  });
  
});

Parse.Cloud.beforeSave("VendorOrder", function(request, response) {
  logInfo('VendorOrder beforeSave --------------------------------');
  var vendorOrder = request.object;
  
  delay(10).then(function() {
    logInfo('go');
    // Remove any vendor order variants who have 0 units to order
    if (vendorOrder.has('vendorOrderVariants') && vendorOrder.get('vendorOrderVariants').length > 0) {
      logInfo('vendor order has ' + vendorOrder.get('vendorOrderVariants').length + ' vendor order variants to fetch');
      return Parse.Object.fetchAll(vendorOrder.get('vendorOrderVariants'));
    } else {
      return [];
    }
    
  }).then(function(vendorOrderVariants) {
    logInfo('vendor order has ' + vendorOrderVariants.length + ' vendor order variants');
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      if (vendorOrderVariant.has('units')) logInfo('vendor order variant has ' + vendorOrderVariant.get('units') + ' units');
      if (vendorOrderVariant.get('units') == 0) vendorOrder.remove('vendorOrderVariants', vendorOrderVariant);
    });
  
    // Create a unique vendor order number
    return vendorOrder.get('vendor').fetch();
    
  }).then(function(vendor){
    if (!vendorOrder.has('vendorOrderNumber')) {
      vendor.increment('vendorOrderCount', 1);
      var vendorOrderNumber = vendor.get('abbreviation') + vendor.get('vendorOrderCount');
      logInfo(vendorOrderNumber);
      vendorOrder.set('vendorOrderNumber', vendorOrderNumber);
      return vendor.save(null, {useMasterKey:true});
      
    } else {
      return false;
    }
    
  }).then(function(result) {
    logInfo('VendorOrder beforeSave complete');
    response.success();
  });
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var createDesignerObject = function(designerData, currentDesigner) {
  var designer = (currentDesigner) ? currentDesigner : new Designer();
  
  designer.set('designerId', parseInt(designerData.id));
  designer.set('name', designerData.name);
  if (!designer.get('abbreviation')) {
    var abbreviation = getAbbreviation(designerData.name);
    designer.set('abbreviation', abbreviation);
  }
  designer.set('image_file', designerData.image_file);
  
  return designer;
}

var getAbbreviation = function(name) {
  var abbreviation = name;
  abbreviation = abbreviation.toUpperCase();
  abbreviation = abbreviation.replace(/-/g, '');
  abbreviation = abbreviation.replace(/\./g, '');
  abbreviation = abbreviation.replace(/\+/g, '');
  abbreviation = abbreviation.replace(/\(|\)/g, '');
  abbreviation = abbreviation.replace(/ /g, '');
  return abbreviation.substring(0, 3);
}

var getDesignerSort = function(designersQuery, currentSort) {
  switch (currentSort) {
    case 'name-desc':
      designersQuery.descending("name");
      break;
    case 'name-asc':
      designersQuery.ascending("name");
      break;
    default:
      designersQuery.ascending("name");
      break;
  }
  return designersQuery;
}

var convertVendorOrderMessage = function(message, vendorOrderVariants) {
  var pTag = '<p style="box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-weight: normal; margin: 0 0 10px 0;">';
  var thTag = '<th style="box-sizing: border-box; color: #999; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 80%; margin: 0; padding: 8px; text-transform: uppercase; text-align:left;">';
  var thRightTag = '<th style="box-sizing: border-box; color: #999; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; font-size: 80%; margin: 0; padding: 8px; text-transform: uppercase; text-align:right;">';
  var trTag = '<tr style="box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0;">';
  var tdTag = '<td style="border-top: #eee 1px solid; box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0; padding: 8px; vertical-align: top; text-align:left;">';
  var tdRightTag = '<td style="border-top: #eee 1px solid; box-sizing: border-box; font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; margin: 0; padding: 8px; vertical-align: top; text-align:right;">';
  
  message = message.replace(/(?:\r\n|\r\r|\n\n)/g, '</p>' + pTag);
  message = message.replace(/(?:\r|\n)/g, '<br/>');
  message = pTag + message;
  message += '</p>';
  
  var productsTable = '<table class="order" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0; padding: 0; border: 1px solid #eee; border-radius: 5px;">';
  productsTable += '<thead>';
  productsTable += thTag + 'Style Name</th>';
  productsTable += thTag + 'Options</th>';
  productsTable += thTag + 'Notes</th>';
  productsTable += thRightTag + 'Units</th>';
  productsTable += '</thead>';
  productsTable += '<tbody>';
  _.each(vendorOrderVariants, function(vendorOrderVariant) {
    productsTable += trTag;
    var variant = vendorOrderVariant.get('variant');
    productsTable += tdTag;
    productsTable += variant.has('designerProductName') ? variant.get('designerProductName') : variant.get('productName');
    productsTable += '</td>';
    var optionsList = '';
    _.each(variant.get('variantOptions'), function(option) {
      optionsList += option.display_name + ': ' + option.label + '<br/>';
    });
    productsTable += tdTag + optionsList + '</td>';
    var notes = vendorOrderVariant.get('notes');
    if (vendorOrderVariant.get('isResize') == true && vendorOrderVariant.has('resizeVariant')) {
      var resizeVariant = vendorOrderVariant.get('resizeVariant');
      notes = 'Resize from size ' + resizeVariant.get('size_value') + '<br/>' + notes;
    }
    productsTable += tdTag + notes + '</td>';
    productsTable += tdRightTag + vendorOrderVariant.get('units') + '</td>';
    productsTable += '</tr>';
  });
  productsTable += '</tbody></table>';
  
  message = message.replace('{{PRODUCTS}}', productsTable);
  
/*   message = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>Billing e.g. invoices and receipts</title></head><body itemscope="" itemtype="http://schema.org/EmailMessage" style="-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;box-sizing:border-box;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;height:100%;line-height:1.6em;width:100%!important" margin: 0; padding: 0;><style>@media only screen and (max-width:640px){h1,h2,h3,h4{font-weight:800!important;margin:20px 0 5px!important}h1{font-size:22px!important}h2{font-size:18px!important}h3{font-size:16px!important}.order{width:100%!important}}</style>' + message + '</body></html>'; */
  
  return message;
}

var destroyVendorOrder = function(vendorOrder) {
  var vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
  var orderProductsToSave = [];

  // Get all VendorOrderVariants and their OrderProducts
  _.each(vendorOrderVariants, function(vendorOrderVariant) {
    _.each(vendorOrderVariant.get('orderProducts'), function(orderProduct) {
      var addedToSave = false;
      _.each(orderProduct.get('vendorOrders'), function(orderProductVendorOrder) {
        if (orderProductVendorOrder.id == vendorOrder.id) {
          logInfo('removing vendorOrder from order product ' + orderProduct.get('orderProductId') + ' vendorOrders');
          orderProduct.remove('vendorOrders', orderProductVendorOrder);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
      _.each(orderProduct.get('awaitingInventoryVendorOrders'), function(orderProductVendorOrder) {
        if (orderProductVendorOrder.id == vendorOrder.id) {
          logInfo('removing vendorOrder from order product ' + orderProduct.get('orderProductId') + ' awaitingInventoryVendorOrders');
          orderProduct.remove('awaitingInventoryVendorOrders', orderProductVendorOrder);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
      _.each(orderProduct.get('awaitingInventory'), function(orderProductVendorOrderVariant) {
        if (orderProductVendorOrderVariant.id == vendorOrderVariant.id) {
          logInfo('removing vendorOrderVariant from order product ' + orderProduct.get('orderProductId') + ' awaitingInventory');
          orderProduct.remove('awaitingInventory', vendorOrderVariant);
          if (!addedToSave) orderProductsToSave.push(orderProduct);
          addedToSave = true;
        }
      });
    });
  });
    
  return Parse.Object.saveAll(orderProductsToSave, {useMasterKey: true}).then(function() {
    logInfo('order products saved');
    return Parse.Object.destroyAll(vendorOrderVariants);
    
  }).then(function() {
    logInfo('destroy vendorOrder ' + vendorOrder.get('vendorOrderNumber'));
    return vendorOrder.destroy();
    
  }, function(error) {
    logError(error);
    return error;
    
  });
}

var delay = function(t) {
  return new Promise(function(resolve) { 
    setTimeout(resolve, t)
  });
}

var logInfo = function(i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  console.error(e);
	if (isProduction) bugsnag.notify(e);
}