var { BaseModel } = require('../database/base.model');
var moment = require('moment');

exports.DesignersModel = new class DesignersModel extends BaseModel {
  constructor(){
    super();
    this.Designer = new Parse.Object.extend('Designer');
    this.Vendor = new Parse.Object.extend('Vendor');
    this.VendorOrder = new Parse.Object.extend('VendorOrder');
    this.VendorOrderVariant = new Parse.Object.extend('VendorOrderVariant');
  }

  /**
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getVendorOrdersByFilters(params) {
    const ordersQuery = new Parse.Query(this.VendorOrder);
    return this.searchDatabase(params, ordersQuery);
  } // END getOrdersByFilters

  /**
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getVendorOrdersVariantsByFilters(params) {
    const ordersQuery = new Parse.Query(this.VendorOrderVariant);
    return this.searchDatabase(params, ordersQuery);
  } // END getVendorOrdersVariantsByFilters
  
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
        throw { message: `The vendor order variant ${productObjectId} doesn't exist.`}

      const targetProductOrdered = targetProduct.get('units');
      const productVariant = targetProduct.get('variant');
      const totalAwaitingInventory = productVariant.get('totalAwaitingInventory') - targetProductOrdered;
      targetProduct.set('deleted', true)
        .set('deletedAt', new Date())
        .set('done', true);
      productVariant.set('totalAwaitingInventory', totalAwaitingInventory > 0 ? totalAwaitingInventory : 0);
      return Promise.all([
        targetProduct.save(),
        productVariant.save(),
      ])
      .then(results => ({
        vendorOrder: vendorOrder,
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

  finishPendingVendorOrderProduct(vendorOrderObjectId, vendorOrderVariantObjectId) {
    if (typeof vendorOrderObjectId === 'undefined' || typeof vendorOrderVariantObjectId === 'undefined')
      throw { message: `The vendor order and variant id ${productObjectId} doesn't exist.` };

    const getVendorOrder = vendorOrderObjectId => this.searchDatabase({
      includes: ['vendorOrderVariants', 'vendorOrderVariants.variant'],
      equal: [{ key: 'objectId', value: vendorOrderObjectId }]
    }, new Parse.Query(this.VendorOrder)).first();

    const extractVendorOrderVariant = (vendorOrder, vendorOrderVariantObjectId) => {
     const vendorOrderVariants = vendorOrder.get('vendorOrderVariants');
     const index = vendorOrderVariants.findIndex(vov => vov.id === vendorOrderVariantObjectId);
     return {
       vendorOrder,
       vendorOrderVariant: vendorOrderVariants[index]
     };
    }

    const finishVariant = ({ vendorOrder, vendorOrderVariant }) => {
      return vendorOrderVariant.set('deleted', true)
        .set('deletedAt', new Date())
        .set('done', true)
        .save()
        .then(vendorOrderVariant => ({
          vendorOrder,
          vendorOrderVariant
        }));
    }

    const transformToJSON = ({ vendorOrder, vendorOrderVariant }) => {
      return Promise.all([
        vendorOrder.toJSON(),
        vendorOrderVariant.toJSON()
      ]).then(results => ({
        vendorOrder: results[0],
        vendorOrderVariant: results[1],
        vendorOrderObjectId,
        vendorOrderVariantObjectId
      }));
    }

    return getVendorOrder(vendorOrderObjectId)
      .then(vendorOrder => extractVendorOrderVariant(vendorOrder, vendorOrderVariantObjectId))
      .then(finishVariant)
      .then(transformToJSON);
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