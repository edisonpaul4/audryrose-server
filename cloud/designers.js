var _ = require('underscore');
var moment = require('moment');
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

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getDesigners", function(request, response) {
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
  designersQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
  
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

/*
Parse.Cloud.define("saveDesigner", function(request, response) {
  var objectId = request.params.objectId;
  var email = request.params.email;
  var designerToUpdate;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', objectId);
  designerQuery.first().then(function(designer) {
    if (designer) designerToUpdate = designer;
    
    if (designer) {
      if (email && email != '') {
        designerToUpdate.set('email', email);
      } else {
        designerToUpdate.unset('email');
      }
    }
    return designerToUpdate.save(null, {useMasterKey: true});
    
  }).then(function(designerObject) {
	  response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});
*/

Parse.Cloud.define("loadDesigner", function(request, response) {
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
  var designerId = request.params.data.designerId;
  var vendorId = request.params.data.vendorId;
  var name = request.params.data.name;
  var firstName = request.params.data.firstName;
  var lastName = request.params.data.lastName;
  var email = request.params.data.email;
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
    if (name && name != '') {
      vendor.set('email', email);
    } else {
      vendor.unset('email');
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
    return designerQuery.first();
    
  }).then(function(designerObject) {
    response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});

Parse.Cloud.define("saveVendorOrder", function(request, response) {
  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var variantsData = request.params.data.variantsData;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants = [];
  var vendor;
  var hasResize = false;
  var hasOrder = false;
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
        vendorOrderVariantQuery.equalTo('done', false);
        vendorOrderVariantQuery.include('variant');
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
              var diff = parseFloat(variantData.received) - vendorOrderVariant.get('received');
              logInfo('add ' + diff + ' to variant inventory');
              variant.increment('inventoryLevel', diff);
            }
            vendorOrderVariant.set('received', parseFloat(variantData.received));
            if (vendorOrderVariant.get('received') >= vendorOrderVariant.get('units')) vendorOrderVariant.set('done', true);
          }
          return vendorOrderVariant.save(null, {useMasterKey:true});
        } else {
          logInfo('VendorOrderVariant not found');
          return;
        }
        
      }).then(function(vendorOrderVariant) {
        if (vendorOrderVariant && vendorOrderVariant.has('units') && vendorOrderVariant.get('units') > 0) {
          logInfo('VendorOrderVariant saved');
          logInfo('Variant has ' + vendorOrderVariant.get('units') + ' units');
          if (vendorOrderVariant.has('isResize') && vendorOrderVariant.get('isResize') == true) {
            hasResize = true;
          } else {
            hasOrder = true;
          }
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
      });
    });
    
    return promise;
    
    
  }).then(function() {
    vendorOrder.set('vendorOrderVariants', vendorOrderVariants);
    logInfo('Total ' + vendorOrderVariants.length + ' vendorOrderVariants');
    if (vendorOrderVariants.length > 0) {
      logInfo('Save changes to vendor order');
      vendorOrder.set('message', message);
      vendorOrder.set('hasResize', hasResize);
      vendorOrder.set('hasOrder', hasOrder);
      if (numReceived >= vendorOrderVariants.length) {
        vendorOrder.set('receivedAll', true);
        vendor.remove('vendorOrders', vendorOrder);
      }
      return vendorOrder.save(null, {useMasterKey:true});
    } else {
      logInfo('All variants removed, destroy the vendor order');
      vendor.remove('vendorOrders', vendorOrder);
      return vendorOrder.destroy();
    }
    
  }).then(function() {
    return vendor.save(null, {useMasterKey:true})
    
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
  	
  }).then(function(result) {
    logInfo('products saved');
    
    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    return designerQuery.first();
    
  }).then(function(designerObject) {
    response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});

Parse.Cloud.define("sendVendorOrder", function(request, response) {
  var designerId = request.params.data.designerId;
  var orderId = request.params.data.orderId;
  var message = request.params.data.message;
  var vendorOrder;
  var vendorOrderVariants;
  var vendor;
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
  vendorOrderQuery.first().then(function(result) {
    vendorOrder = result;
    vendor = vendorOrder.get('vendor');
    vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
    
    _.each(vendorOrderVariants, function(vendorOrderVariant) {
      vendorOrderVariant.set('ordered', true);
      var variant = vendorOrderVariant.get('variant');
      if (productIds.indexOf(variant.get('productId') < 0)) productIds.push(variant.get('productId'));
    });
    messageProductsHTML = convertVendorOrderMessage(messageProductsHTML, vendorOrderVariants);
    
    if (!vendor.has('email')) {
      errors.push('Error sending order: ' + vendor.get('name') + ' needs an email address.');
      response.success({errors: errors});
      return false;
    }
    var data = {
      from: 'Jaclyn <jaclyn@loveaudryrose.com>',
      to: vendor.get('email'),
      subject: 'Audry Rose Order ' + moment().format('M.D.YY'),
      text: messageProductsText,
      html: messageProductsHTML
    }
//     console.log(data)
    return mailgun.messages().send(data);
    
  }).then(function(body) {
    console.log(body);
    emailId = body.id;
    successMessage = 'Order successfully sent to ' + vendor.get('email');
    logInfo(successMessage);
    
    return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});
    
  }).then(function() {
    logInfo(vendorOrderVariants.length + ' vendorOrderVariants saved');
    vendorOrder.set('orderedAll', true);
    vendorOrder.set('emailId', emailId);
    return vendorOrder.save(null, {useMasterKey: true});
    
  }).then(function() {
    logInfo('vendorOrder saved');
    vendor.addUnique('vendorOrders', vendorOrder);
    return vendor.save(null, {useMasterKey: true});
    
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
  	
  }).then(function(result) {
    logInfo('products saved');
    return delay(1000);
    
  }).then(function() {
    
    var designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    designerQuery.include('vendors.vendorOrders');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants');
    designerQuery.include('vendors.vendorOrders.vendorOrderVariants.variant');
    return designerQuery.first();
    
  }).then(function(designerObject) {
    logInfo('sendVendorOrder complete');
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
  var vendor = request.object;
  var hasPendingVendorOrder = false;
  var hasSentVendorOrder = false;
  var vendorDesigners;
  
  if (vendor.has('vendorOrders')) {
    var vendorOrders = vendor.get('vendorOrders');
    Parse.Object.fetchAll(vendorOrders).then(function(vendorOrderObjects) {
      _.each(vendorOrderObjects, function(vendorOrder) {
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
      vendorDesigners = vendor.get('designers');
      return Parse.Object.fetchAll(vendorDesigners);
      
    }).then(function(designers) {
      _.each(designers, function(designer) {
        designer.set('hasPendingVendorOrder', hasPendingVendorOrder);
        designer.set('hasSentVendorOrder', hasSentVendorOrder);
      });
      return Parse.Object.saveAll(designers, {useMasterKey: true});
      
    }).then(function() {
      response.success();
    });
  } else {
    vendorDesigners = vendor.get('designers');
    Parse.Object.fetchAll(vendorDesigners).then(function(designers) {
      _.each(designers, function(designer) {
        designer.set('hasPendingVendorOrder', hasPendingVendorOrder);
        designer.set('hasSentVendorOrder', hasSentVendorOrder);
      });
      return Parse.Object.saveAll(designers, {useMasterKey: true});
    }).then(function() {
      response.success();
    })
  }
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var createDesignerObject = function(designerData, currentDesigner) {
  var designer = (currentDesigner) ? currentDesigner : new Designer();
  
  designer.set('designerId', parseInt(designerData.id));
  designer.set('name', designerData.name);
  if (!designer.get('abbreviation')) {
    var abbreviation = designerData.name;
    abbreviation = abbreviation.toUpperCase();
    abbreviation = abbreviation.replace(/-/g, '');
    abbreviation = abbreviation.replace(/\./g, '');
    abbreviation = abbreviation.replace(/\+/g, '');
    abbreviation = abbreviation.replace(/\(|\)/g, '');
    abbreviation = abbreviation.replace(/ /g, '');
    designer.set('abbreviation', abbreviation.substring(0, 3));
  }
  designer.set('image_file', designerData.image_file);
  
  return designer;
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
  productsTable += thRightTag + 'Units</th>';
  productsTable += '</thead>';
  productsTable += '<tbody>';
  _.each(vendorOrderVariants, function(vendorOrderVariant) {
    productsTable += trTag;
    var variant = vendorOrderVariant.get('variant');
    productsTable += tdTag + variant.get('productName') + '</td>';
    var optionsList = '';
    _.each(variant.get('variantOptions'), function(option) {
      optionsList += option.display_name + ': ' + option.label + '<br/>';
    });
    productsTable += tdTag + optionsList + '</td>';
    productsTable += tdRightTag + vendorOrderVariant.get('units') + '</td>';
    productsTable += '</tr>';
  });
  productsTable += '</tbody></table>';
  
  message = message.replace('{{PRODUCTS}}', productsTable);
  
/*   message = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>Billing e.g. invoices and receipts</title></head><body itemscope="" itemtype="http://schema.org/EmailMessage" style="-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;box-sizing:border-box;font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;height:100%;line-height:1.6em;width:100%!important" margin: 0; padding: 0;><style>@media only screen and (max-width:640px){h1,h2,h3,h4{font-weight:800!important;margin:20px 0 5px!important}h1{font-size:22px!important}h2{font-size:18px!important}h3{font-size:16px!important}.order{width:100%!important}}</style>' + message + '</body></html>'; */
  
  return message;
}

var delay = function(t) {
  return new Promise(function(resolve) { 
    setTimeout(resolve, t)
  });
}

var logInfo = function(i, alwaysLog) {
  if (process.env.NODE_ENV == 'development' || process.env.DEBUG == 'true' || alwaysLog) console.info(i);
}

var logError = function(e) {
  var msg = JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}