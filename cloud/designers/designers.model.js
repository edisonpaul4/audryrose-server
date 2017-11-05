var { BaseModel } = require('../database/base.model');
var moment = require('moment');

exports.DesignersModel = new class DesignersModel extends BaseModel {
  constructor(){
    super();
    this.Designer = new Parse.Object.extend('Designer');
    this.Vendor = new Parse.Object.extend('Vendor');
    this.VendorOrder = new Parse.Object.extend('VendorOrder');
  }
  
  finishVendorOrder(vendorOrderNumber){
    console.log('DesignersModel::finishVendorOrder => searching order with vendorOrderNumber:', vendorOrderNumber);
    var query = new Parse.Query(this.VendorOrder);

    var setVendorOrderAsCompleted = vendorOrder => {
      console.log('DesignersModel::finishVendorOrder::setVendorOrderAsCompleted');
      return new Promise((resolve, reject) => {
        switch (true) {
          case typeof vendorOrder === 'undefined':
            reject({ 
              message: `Vendor order ${vendorOrderNumber} doesn't exist.` 
            });
          break;

          case vendorOrder.get('receivedAll') === true:
            reject({ 
              message: `Vendor order ${vendorOrderNumber} is already completed.` 
            });
          break;

          default:
            vendorOrder.set('dateReceived', moment().toDate())
            vendorOrder.set('receivedAll', true)
              .save()
              .then(vendorOrder => resolve(vendorOrder))
              .reject(error => reject(error));
          break;
        }
      })
    }

    var updateVendor = vendorOrder => {
      console.log('DesignersModel::finishVendorOrder::updateVendor');
      return vendorOrder.get('vendor').save()
        .then(vendor => vendorOrder);
    }

    var updateVariants = vendorOrder => {
      console.log('DesignersModel::finishVendorOrder::updateVariants');
      return Promise.all(
        vendorOrder.get('vendorOrderVariants').map(vov => {
          return vov.set('done', true).save()
            .then(vov => {
              const awaiting = vov.get('units') - vov.get('received');
              const productVariant = vov.get('variant');
              const totalAwaitingInventory = productVariant.get('totalAwaitingInventory') - (awaiting > 0 ? awaiting : 0);
              productVariant.set('totalAwaitingInventory', totalAwaitingInventory > 0 ? totalAwaitingInventory : 0);
              return productVariant.save();
            })
        })
      ).then(list => vendorOrder);
      
    }

    var filter = {
      includes: ['vendor', 'vendorOrderVariants', 'vendorOrderVariants.variant'],
      equal: [
        { key: 'vendorOrderNumber', value: vendorOrderNumber }
      ]
    };
    return this.searchDatabase(filter, query)
      .first()
      .then(setVendorOrderAsCompleted)
      .then(updateVariants)
      .then(updateVendor);
  }

  getDesignerByObjectId(objectId, includes = []){
    var query = new Parse.Query(this.Designer);
    var filters = {
      includes: includes,
      equal: [
        { key: 'objectId', value: objectId }
      ]
    };
    return this.searchDatabase(filters, query)
      .first();
  }

  deleteProductFromVendorOrder(productObjectId, vendorOrderNumber) {
    var query = new Parse.Query(this.VendorOrder);

    var destroyProduct = vendorOrder => {
      var products = vendorOrder.get('vendorOrderVariants');
      var targetProduct = products[products.findIndex(p => p.id === productObjectId)];
      if(targetProduct === null || typeof targetProduct === 'undefined')
        throw { message: `The product ${productObjectId} doesn't exist.`}

      const targetProductOrdered = targetProduct.get('units');
      const productVariant = targetProduct.get('variant');
      const totalAwaitingInventory = productVariant.get('totalAwaitingInventory') - targetProductOrdered;
      productVariant.set('totalAwaitingInventory', totalAwaitingInventory > 0 ? totalAwaitingInventory : 0);

      return Promise.all([
        productVariant.save(),
        vendorOrder.remove('vendorOrderVariants', targetProduct).save()
      ])
      .then(results => ({
        vendorOrder: results[1],
        vendorOrderVariant: targetProduct
      }));
    }

    var filters = {
      includes: ['vendorOrderVariants', 'vendorOrderVariants.variant'],
      equal: [
        { key: 'vendorOrderNumber', value: vendorOrderNumber }
      ]
    }
    return this.searchDatabase(filters, query)
      .first()
      .then(destroyProduct);
  }

  getForcedClearedOrders() {
    // the search will start always from 15th October 2017
    var query = new Parse.Query(this.VendorOrder);
    const filters = {
      includes: ['vendorOrderVariants', 'vendorOrderVariants.variant'],
      greaterOrEqual: [ { key: 'updatedAt', value: moment('20171015').toDate() } ],
      equal: [ { key: 'receivedAll', value: true } ],
      notExists: ['dateReceived']
    };
    return this.searchDatabase(filters, query)
      .find();
  }

}